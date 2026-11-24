package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/argon2"
	_ "modernc.org/sqlite"
)

var appVersion = "1.0.0"

type app struct {
	db               *sql.DB
	dir, web, origin string
	mu               sync.Mutex
	loginMu          sync.Mutex
	attempts         map[string]attempt
	agentMu          sync.Mutex
	agentHits        map[string]attempt
}
type attempt struct {
	count int
	start time.Time
}
type user struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Admin    bool   `json:"admin"`
	Quota    int64  `json:"quota"`
	Used     int64  `json:"used"`
	Disabled bool   `json:"disabled"`
}
type record struct {
	ID        string         `json:"id"`
	Kind      string         `json:"kind"`
	Version   int64          `json:"version"`
	UpdatedAt string         `json:"updatedAt"`
	DeletedAt *string        `json:"deletedAt"`
	Value     map[string]any `json:"value"`
}
type mutation struct {
	OpID   string `json:"opId"`
	Base   int64  `json:"base"`
	Record record `json:"record"`
}
type receipt struct {
	OpID      string  `json:"opId"`
	Record    record  `json:"record"`
	Conflict  *record `json:"conflict,omitempty"`
	Unchanged bool    `json:"unchanged,omitempty"`
}
type compactReceipt struct {
	OpID      string  `json:"opId"`
	ID        string  `json:"id"`
	Version   int64   `json:"version"`
	UpdatedAt string  `json:"updatedAt"`
	Unchanged bool    `json:"unchanged,omitempty"`
	Purged    bool    `json:"purged,omitempty"`
	Record    *record `json:"record,omitempty"`
	Conflict  *record `json:"conflict,omitempty"`
}
type apiError struct {
	status int
	msg    string
}

func (e apiError) Error() string { return e.msg }
func bad(s string) error         { return apiError{400, s} }
func now() string                { return time.Now().UTC().Format(time.RFC3339Nano) }
func randomID() string {
	b := make([]byte, 16)
	_, e := rand.Read(b)
	if e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func randomToken() string {
	b := make([]byte, 32)
	_, e := rand.Read(b)
	if e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func hashToken(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func passwordHash(s string) string {
	salt := make([]byte, 16)
	rand.Read(salt)
	h := argon2.IDKey([]byte(s), salt, 2, 32*1024, 2, 32)
	return hex.EncodeToString(salt) + ":" + hex.EncodeToString(h)
}
func passwordOK(s, h string) bool {
	parts := strings.Split(h, ":")
	if len(parts) != 2 {
		return false
	}
	salt, e := hex.DecodeString(parts[0])
	if e != nil {
		return false
	}
	want, e := hex.DecodeString(parts[1])
	if e != nil {
		return false
	}
	got := argon2.IDKey([]byte(s), salt, 2, 32*1024, 2, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}

func openApp(dir, web, origin string) (*app, error) {
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
	if e := os.MkdirAll(filepath.Join(dir, "blobs"), 0700); e != nil {
		return nil, e
	}
	db, e := sql.Open("sqlite", filepath.Join(dir, "yonote.db"))
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	a := &app{db: db, dir: dir, web: web, origin: origin, attempts: map[string]attempt{}, agentHits: map[string]attempt{}}
	_, e = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,pass TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0,quota INTEGER NOT NULL DEFAULT 2147483648,disabled INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,token TEXT UNIQUE NOT NULL,last_seen TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,prefix TEXT NOT NULL,key_hash TEXT UNIQUE NOT NULL,scopes TEXT NOT NULL,folder_ids TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT);
 CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys(user_id);
 CREATE TABLE IF NOT EXISTS records(id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,version INTEGER NOT NULL,updated TEXT NOT NULL,deleted TEXT,payload TEXT NOT NULL,content_hash TEXT NOT NULL DEFAULT '',PRIMARY KEY(user_id,id));
 CREATE INDEX IF NOT EXISTS records_user_version ON records(user_id,version);
 CREATE TABLE IF NOT EXISTS sync_seq(id INTEGER PRIMARY KEY CHECK(id=1),seq INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,record TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS changes_user_seq ON changes(user_id,seq);
 CREATE TABLE IF NOT EXISTS receipts(user_id TEXT NOT NULL,op_id TEXT NOT NULL,response TEXT NOT NULL,created TEXT NOT NULL DEFAULT '',PRIMARY KEY(user_id,op_id));
 CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,note_id TEXT NOT NULL,created TEXT NOT NULL,record TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS history_note ON history(user_id,note_id,created);
 CREATE TABLE IF NOT EXISTS blobs(user_id TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL,PRIMARY KEY(user_id,hash));
 CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,note_id TEXT NOT NULL,hash TEXT NOT NULL,filename TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS attachments_note ON attachments(user_id,note_id);
 CREATE TABLE IF NOT EXISTS shares(token TEXT PRIMARY KEY,user_id TEXT NOT NULL,note_id TEXT NOT NULL,created TEXT NOT NULL);
 CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(user_id UNINDEXED,record_id UNINDEXED,title,body,tokenize='trigram');`)
	if e != nil {
		db.Close()
		return nil, e
	}
	if e = migrateSyncSchema(db); e != nil {
		db.Close()
		return nil, e
	}
	return a, nil
}
func ensureColumn(db *sql.DB, table, column, ddl string) error {
	rows, e := db.Query("PRAGMA table_info(" + table + ")")
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt any
		if e = rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); e != nil {
			return e
		}
		if name == column {
			return nil
		}
	}
	if e = rows.Err(); e != nil {
		return e
	}
	_, e = db.Exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + ddl)
	return e
}
func migrateSyncSchema(db *sql.DB) error {
	if e := ensureColumn(db, "records", "content_hash", "TEXT NOT NULL DEFAULT ''"); e != nil {
		return e
	}
	if e := ensureColumn(db, "receipts", "created", "TEXT NOT NULL DEFAULT ''"); e != nil {
		return e
	}
	// Preserve monotonic cursor continuity across existing deployments by inheriting the highest historical seq/version.
	if _, e := db.Exec(`INSERT OR IGNORE INTO sync_seq(id,seq) VALUES(1, max(
		COALESCE((SELECT max(seq) FROM changes), 0),
		COALESCE((SELECT max(version) FROM records), 0)
	))`); e != nil {
		return e
	}
	// Reclaim legacy append-only pull log now that /api/changes serves directly from records(user_id, version).
	if _, e := db.Exec("DELETE FROM changes"); e != nil {
		return e
	}
	return nil
}
func (a *app) bootstrap(username, password string) error {
	var n int
	if e := a.db.QueryRow("SELECT count(*) FROM users").Scan(&n); e != nil {
		return e
	}
	if n > 0 {
		return nil
	}
	if strings.TrimSpace(username) == "" && password == "" {
		log.Printf("首次启动：尚未创建管理员账号，请打开网页「设置 → 账号与同步」完成初始化（或通过 YONOTE_ADMIN / YONOTE_PASSWORD 环境变量静默创建）")
		return nil
	}
	if len(password) < 12 || strings.TrimSpace(username) == "" {
		return errors.New("first start: set YONOTE_ADMIN and YONOTE_PASSWORD (at least 12 characters)")
	}
	_, e := a.db.Exec("INSERT INTO users(id,username,pass,admin) VALUES(?,?,?,1)", randomID(), strings.TrimSpace(username), passwordHash(password))
	return e
}
func output(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func decodeLimit(w http.ResponseWriter, r *http.Request, v any, maxBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	d := json.NewDecoder(r.Body)
	if e := d.Decode(v); e != nil {
		return bad("请求内容格式错误或超出大小限制")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return bad("请求格式错误")
	}
	return nil
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	return decodeLimit(w, r, v, 8<<20)
}
func fail(w http.ResponseWriter, e error) {
	var ae apiError
	if errors.As(e, &ae) {
		output(w, ae.status, map[string]string{"error": ae.msg})
	} else {
		log.Printf("request failed: %v", e)
		output(w, 500, map[string]string{"error": "服务暂时繁忙，请稍后重试"})
	}
}

type handler func(http.ResponseWriter, *http.Request, user) error

func (a *app) auth(admin bool, h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		var u user
		e := a.db.QueryRow(`SELECT u.id,u.username,u.admin,u.quota,u.disabled,COALESCE((SELECT sum(size) FROM blobs WHERE user_id=u.id),0) FROM users u JOIN devices d ON d.user_id=u.id WHERE d.token=?`, hashToken(token)).Scan(&u.ID, &u.Username, &u.Admin, &u.Quota, &u.Disabled, &u.Used)
		if e != nil || u.Disabled {
			fail(w, apiError{401, "登录已失效，请重新连接账号"})
			return
		}
		if admin && !u.Admin {
			fail(w, apiError{403, "需要管理员权限"})
			return
		}
		a.db.Exec("UPDATE devices SET last_seen=? WHERE token=?", now(), hashToken(token))
		if e = h(w, r, u); e != nil {
			fail(w, e)
		}
	}
}
func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		output(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/setup", a.setupStatus)
	mux.HandleFunc("POST /api/setup", a.setup)
	mux.HandleFunc("POST /api/login", a.login)
	mux.HandleFunc("GET /api/me", a.auth(false, func(w http.ResponseWriter, r *http.Request, u user) error { output(w, 200, u); return nil }))
	mux.HandleFunc("POST /api/sync", a.auth(false, a.push))
	mux.HandleFunc("GET /api/changes", a.auth(false, a.pull))
	mux.HandleFunc("GET /api/search", a.auth(false, a.search))
	mux.HandleFunc("GET /api/history/{id}", a.auth(false, a.history))
	mux.HandleFunc("DELETE /api/records/{id}", a.auth(false, a.purge))
	mux.HandleFunc("POST /api/attachments/check", a.auth(false, a.checkAttachment))
	mux.HandleFunc("POST /api/attachments", a.auth(false, a.upload))
	mux.HandleFunc("GET /api/attachments/{id}", a.auth(false, a.download))
	mux.HandleFunc("DELETE /api/attachments/{id}", a.auth(false, a.removeAttachment))
	mux.HandleFunc("GET /api/shares/{id}", a.auth(false, a.listShares))
	mux.HandleFunc("POST /api/shares/{id}", a.auth(false, a.createShare))
	mux.HandleFunc("DELETE /api/shares/{token}", a.auth(false, a.revokeShare))
	mux.HandleFunc("GET /api/public/{token}", a.publicShare)
	mux.HandleFunc("GET /api/public/{token}/attachments/{id}", a.publicAttachment)
	mux.HandleFunc("GET /api/devices", a.auth(false, a.devices))
	mux.HandleFunc("DELETE /api/devices/{id}", a.auth(false, a.revokeDevice))
	mux.HandleFunc("GET /api/keys", a.auth(false, a.listAPIKeys))
	mux.HandleFunc("POST /api/keys", a.auth(false, a.createAPIKey))
	mux.HandleFunc("DELETE /api/keys/{id}", a.auth(false, a.revokeAPIKey))
	mux.HandleFunc("GET /api/agent/folders", a.authAgent("read", a.httpAgentFolders))
	mux.HandleFunc("GET /api/agent/notes", a.authAgent("read", a.httpAgentListNotes))
	mux.HandleFunc("GET /api/agent/notes/{id}", a.authAgent("read", a.httpAgentReadNote))
	mux.HandleFunc("POST /api/agent/notes", a.authAgent("write", a.httpAgentCreateNote))
	mux.HandleFunc("PATCH /api/agent/notes/{id}", a.authAgent("write", a.httpAgentUpdateNote))
	mux.HandleFunc("POST /api/agent/notes/{id}/append", a.authAgent("write", a.httpAgentAppendNote))
	mux.HandleFunc("POST /api/agent/diary/append", a.authAgent("write", a.httpAgentAppendDiary))
	mux.HandleFunc("DELETE /api/agent/notes/{id}", a.authAgent("write", a.httpAgentTrashNote))
	mux.HandleFunc("GET /api/agent/todos", a.authAgent("read", a.httpAgentListTodos))
	mux.HandleFunc("POST /api/agent/todos", a.authAgent("todo", a.httpAgentCreateTodo))
	mux.HandleFunc("PATCH /api/agent/todos/{id}", a.authAgent("todo", a.httpAgentUpdateTodo))
	mux.HandleFunc("DELETE /api/agent/todos/{id}", a.authAgent("todo", a.httpAgentTrashTodo))
	mux.HandleFunc("/mcp", a.handleMCP)
	mux.HandleFunc("GET /api/admin/users", a.auth(true, a.users))
	mux.HandleFunc("POST /api/admin/users", a.auth(true, a.createUser))
	mux.HandleFunc("PATCH /api/admin/users/{id}", a.auth(true, a.updateUser))
	mux.HandleFunc("DELETE /api/admin/users/{id}", a.auth(true, a.deleteUser))
	mux.HandleFunc("/", a.serveWeb)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/mcp" {
			w.Header().Set("Cache-Control", "no-store")
		}
		origin := r.Header.Get("Origin")
		allowed := origin == "https://localhost" ||
			origin == "capacitor://localhost" ||
			origin == "http://localhost" ||
			origin == "https://tauri.localhost" ||
			origin == "http://tauri.localhost" ||
			origin == a.origin
		if allowed && origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
		}
		if r.Method == "OPTIONS" {
			if !allowed {
				w.WriteHeader(403)
			} else {
				w.WriteHeader(204)
			}
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func (a *app) serveEmbeddedFile(w http.ResponseWriter, r *http.Request, webFS fs.FS, name string) bool {
	f, err := webFS.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		return false
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		return false
	}
	if strings.HasSuffix(name, ".webmanifest") {
		w.Header().Set("Content-Type", "application/manifest+json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
	} else if name == "sw.js" || name == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), rs)
	return true
}
func (a *app) serveWeb(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		output(w, 404, map[string]string{"error": "接口不存在"})
		return
	}
	rel := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if a.web != "" {
		cleanWeb := filepath.Clean(a.web)
		p := filepath.Join(cleanWeb, filepath.FromSlash(rel))
		if p == cleanWeb || strings.HasPrefix(p, cleanWeb+string(filepath.Separator)) {
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				if strings.HasSuffix(p, ".webmanifest") {
					w.Header().Set("Content-Type", "application/manifest+json; charset=utf-8")
					w.Header().Set("Cache-Control", "no-cache")
				} else if strings.HasSuffix(p, string(filepath.Separator)+"sw.js") {
					w.Header().Set("Cache-Control", "no-cache")
				}
				http.ServeFile(w, r, p)
				return
			}
		}
		if s, e := os.Stat(filepath.Join(cleanWeb, "index.html")); e == nil && !s.IsDir() {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, filepath.Join(cleanWeb, "index.html"))
			return
		}
	}
	if webFS := embeddedWeb(); webFS != nil {
		if rel != "" && a.serveEmbeddedFile(w, r, webFS, rel) {
			return
		}
		if a.serveEmbeddedFile(w, r, webFS, "index.html") {
			return
		}
	}
	http.NotFound(w, r)
}
func (a *app) setupStatus(w http.ResponseWriter, r *http.Request) {
	var n int
	if e := a.db.QueryRow("SELECT count(*) FROM users").Scan(&n); e != nil {
		fail(w, e)
		return
	}
	output(w, 200, map[string]bool{"needsSetup": n == 0})
}
func (a *app) setup(w http.ResponseWriter, r *http.Request) {
	var in struct{ Username, Password, Device string }
	if e := decodeLimit(w, r, &in, 4<<10); e != nil {
		fail(w, e)
		return
	}
	username := strings.TrimSpace(in.Username)
	if len(username) < 2 || len(username) > 64 {
		fail(w, bad("用户名长度需在 2 到 64 个字符之间"))
		return
	}
	if len(in.Password) < 12 || len(in.Password) > 256 {
		fail(w, bad("管理员密码至少需要 12 位字符"))
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var n int
	if e := a.db.QueryRow("SELECT count(*) FROM users").Scan(&n); e != nil {
		fail(w, e)
		return
	}
	if n > 0 {
		fail(w, apiError{403, "系统已完成初始化，请直接登录"})
		return
	}
	uid := randomID()
	if _, e := a.db.Exec("INSERT INTO users(id,username,pass,admin) VALUES(?,?,?,1)", uid, username, passwordHash(in.Password)); e != nil {
		fail(w, e)
		return
	}
	token := randomToken()
	device := strings.TrimSpace(in.Device)
	if len(device) > 100 {
		device = device[:100]
	}
	if device == "" {
		device = "管理员设备"
	}
	if _, e := a.db.Exec("INSERT INTO devices(id,user_id,name,token,last_seen) VALUES(?,?,?,?,?)", randomID(), uid, device, hashToken(token), now()); e != nil {
		fail(w, e)
		return
	}
	u := user{ID: uid, Username: username, Admin: true, Quota: 2147483648, Used: 0}
	output(w, 200, map[string]any{"token": token, "user": u})
}
func (a *app) login(w http.ResponseWriter, r *http.Request) {
	var in struct{ Username, Password, Device string }
	if e := decodeLimit(w, r, &in, 4<<10); e != nil {
		fail(w, e)
		return
	}
	if len(in.Username) > 64 || len(in.Password) > 256 {
		fail(w, apiError{401, "账号或密码错误"})
		return
	}
	// Rate limit by direct peer address; reverse proxy is trusted only when explicitly configured outside the app.
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[:i]
	}
	a.loginMu.Lock()
	at := a.attempts[host]
	if time.Since(at.start) > time.Minute {
		at = attempt{start: time.Now()}
	}
	at.count++
	a.attempts[host] = at
	if len(a.attempts) > 4096 {
		for k, v := range a.attempts {
			if time.Since(v.start) > time.Minute {
				delete(a.attempts, k)
			}
		}
	}
	a.loginMu.Unlock()
	if at.count > 12 {
		w.Header().Set("Retry-After", "60")
		fail(w, apiError{429, "尝试次数较多，请一分钟后重试"})
		return
	}
	var u user
	var pass string
	e := a.db.QueryRow("SELECT id,username,pass,admin,quota,disabled FROM users WHERE username=?", strings.TrimSpace(in.Username)).Scan(&u.ID, &u.Username, &pass, &u.Admin, &u.Quota, &u.Disabled)
	if e != nil || !passwordOK(in.Password, pass) || u.Disabled {
		fail(w, apiError{401, "账号或密码错误"})
		return
	}
	token := randomToken()
	if len(in.Device) > 100 {
		in.Device = in.Device[:100]
	}
	if in.Device == "" {
		in.Device = "新设备"
	}
	_, e = a.db.Exec("INSERT INTO devices(id,user_id,name,token,last_seen) VALUES(?,?,?,?,?)", randomID(), u.ID, in.Device, hashToken(token), now())
	if e != nil {
		fail(w, e)
		return
	}
	output(w, 200, map[string]any{"token": token, "user": u})
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8787", "listen address")
	dir := flag.String("data", "./data", "data directory")
	web := flag.String("web", "", "optional external web assets directory (defaults to embedded UI)")
	backup := flag.String("backup", "", "write consistent SQLite snapshot and exit")
	flag.Parse()
	a, e := openApp(*dir, *web, os.Getenv("YONOTE_ORIGIN"))
	if e != nil {
		log.Fatal(e)
	}
	defer a.db.Close()
	if *backup != "" {
		target, e := filepath.Abs(*backup)
		if e != nil {
			log.Fatal(e)
		}
		if _, e = os.Stat(target); !os.IsNotExist(e) {
			log.Fatal("backup target must be a new file")
		}
		if _, e = a.db.Exec("VACUUM INTO ?", target); e != nil {
			log.Fatal(e)
		}
		return
	}
	if e = a.bootstrap(os.Getenv("YONOTE_ADMIN"), os.Getenv("YONOTE_PASSWORD")); e != nil {
		log.Fatal(e)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		a.cleanup()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				a.cleanup()
			}
		}
	}()
	server := &http.Server{Addr: *addr, Handler: a.routes(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 90 * time.Second, WriteTimeout: 90 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(c)
	}()
	log.Printf("便签 listening on %s", *addr)
	if e = server.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}

func stringValue(v map[string]any, k string) string { s, _ := v[k].(string); return s }
func boolValue(v map[string]any, k string) bool     { s, _ := v[k].(bool); return s }
func intQuery(r *http.Request, key string) int64 {
	n, _ := strconv.ParseInt(r.URL.Query().Get(key), 10, 64)
	return n
}
func scanRecord(row interface{ Scan(...any) error }) (record, error) {
	var v record
	var payload string
	var deleted sql.NullString
	e := row.Scan(&v.ID, &v.Kind, &v.Version, &v.UpdatedAt, &deleted, &payload)
	if deleted.Valid {
		v.DeletedAt = &deleted.String
	}
	if e == nil {
		e = json.Unmarshal([]byte(payload), &v.Value)
	}
	return v, e
}
func recordContentHash(v record) string {
	b, _ := json.Marshal(struct {
		Kind    string         `json:"kind"`
		Deleted bool           `json:"deleted"`
		Value   map[string]any `json:"value"`
	}{
		Kind:    v.Kind,
		Deleted: v.DeletedAt != nil,
		Value:   v.Value,
	})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func nextSeq(tx *sql.Tx) (int64, error) {
	if _, e := tx.Exec("UPDATE sync_seq SET seq=seq+1 WHERE id=1"); e != nil {
		return 0, e
	}
	var seq int64
	e := tx.QueryRow("SELECT seq FROM sync_seq WHERE id=1").Scan(&seq)
	return seq, e
}
func getRecord(tx *sql.Tx, uid, id string) (record, error) {
	return scanRecord(tx.QueryRow("SELECT id,kind,version,updated,deleted,payload FROM records WHERE user_id=? AND id=?", uid, id))
}
func getRecordWithHash(tx *sql.Tx, uid, id string) (record, string, error) {
	var v record
	var payload, hash string
	var deleted sql.NullString
	e := tx.QueryRow("SELECT id,kind,version,updated,deleted,payload,content_hash FROM records WHERE user_id=? AND id=?", uid, id).Scan(&v.ID, &v.Kind, &v.Version, &v.UpdatedAt, &deleted, &payload, &hash)
	if deleted.Valid {
		v.DeletedAt = &deleted.String
	}
	if e == nil {
		e = json.Unmarshal([]byte(payload), &v.Value)
		if e == nil && hash == "" {
			hash = recordContentHash(v)
		}
	}
	return v, hash, e
}
func writeRecord(tx *sql.Tx, uid string, v record) (record, error) {
	seq, e := nextSeq(tx)
	if e != nil {
		return v, e
	}
	v.Version = seq
	v.UpdatedAt = now()
	hash := recordContentHash(v)
	payload, e := json.Marshal(v.Value)
	if e != nil {
		return v, e
	}
	_, e = tx.Exec(`INSERT INTO records(id,user_id,kind,version,updated,deleted,payload,content_hash) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET kind=excluded.kind,version=excluded.version,updated=excluded.updated,deleted=excluded.deleted,payload=excluded.payload,content_hash=excluded.content_hash`, v.ID, uid, v.Kind, v.Version, v.UpdatedAt, v.DeletedAt, string(payload), hash)
	if e != nil {
		return v, e
	}
	if _, e = tx.Exec("DELETE FROM search WHERE user_id=? AND record_id=?", uid, v.ID); e != nil {
		return v, e
	}
	if v.DeletedAt == nil && v.Kind != "folder" {
		_, e = tx.Exec("INSERT INTO search(user_id,record_id,title,body) VALUES(?,?,?,?)", uid, v.ID, stringValue(v.Value, "title"), stringValue(v.Value, "plainText")+" "+stringValue(v.Value, "note"))
	}
	return v, e
}
func validRecord(tx *sql.Tx, uid string, v record) error {
	if len(v.ID) < 8 || len(v.ID) > 80 {
		return bad("记录 ID 无效")
	}
	if v.Kind != "note" && v.Kind != "todo" && v.Kind != "folder" {
		return bad("记录类型无效")
	}
	if v.Value == nil {
		return bad("内容为空")
	}
	if boolValue(v.Value, "purged") {
		return bad("彻底删除状态由服务器维护")
	}
	if len([]rune(stringValue(v.Value, "title"))) > 500 {
		return bad("标题最多 500 字")
	}
	if v.Kind == "folder" {
		if strings.TrimSpace(stringValue(v.Value, "name")) == "" {
			return bad("请填写文件夹名称")
		}
		m := stringValue(v.Value, "module")
		if m != "note" && m != "todo" {
			return bad("文件夹模块无效")
		}
	} else if folder := stringValue(v.Value, "folderId"); folder != "" {
		f, e := getRecord(tx, uid, folder)
		if e != nil || f.Kind != "folder" || stringValue(f.Value, "module") != v.Kind {
			return bad("文件夹不存在或属于其他模块，请先同步文件夹")
		}
		// A phone may upload an edit after another device deleted its folder.
		// Keep that edit in the default folder instead of blocking its durable queue.
		if f.DeletedAt != nil {
			v.Value["folderId"] = ""
		}
	}
	return nil
}

// Mutations, receipts, conflict copies, history, search index and change cursors commit atomically.
func (a *app) push(w http.ResponseWriter, r *http.Request, u user) error {
	var in struct {
		Mutations []mutation `json:"mutations"`
		Cursor    *int64     `json:"cursor,omitempty"`
		Compact   bool       `json:"compact,omitempty"`
	}
	if e := decode(w, r, &in); e != nil {
		return e
	}
	if len(in.Mutations) > 100 {
		return bad("每批最多 100 条改动")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	out := []receipt{}
	compactOut := []compactReceipt{}
	pushedIDs := map[string]bool{}
	var maxPushedVersion int64
	trackReceipt := func(rr receipt, serverAltered bool) {
		out = append(out, rr)
		pushedIDs[rr.Record.ID] = true
		if rr.Record.Version > maxPushedVersion {
			maxPushedVersion = rr.Record.Version
		}
		if rr.Conflict != nil {
			pushedIDs[rr.Conflict.ID] = true
			if rr.Conflict.Version > maxPushedVersion {
				maxPushedVersion = rr.Conflict.Version
			}
		}
		if in.Compact {
			purged := boolValue(rr.Record.Value, "purged")
			cr := compactReceipt{
				OpID:      rr.OpID,
				ID:        rr.Record.ID,
				Version:   rr.Record.Version,
				UpdatedAt: rr.Record.UpdatedAt,
				Unchanged: rr.Unchanged,
				Purged:    purged,
				Conflict:  rr.Conflict,
			}
			if purged || serverAltered {
				rec := rr.Record
				cr.Record = &rec
			}
			compactOut = append(compactOut, cr)
		}
	}
	for _, m := range in.Mutations {
		if len(m.OpID) < 8 || len(m.OpID) > 100 {
			return bad("改动 ID 无效")
		}
		var cached string
		if tx.QueryRow("SELECT response FROM receipts WHERE user_id=? AND op_id=?", u.ID, m.OpID).Scan(&cached) == nil {
			var v receipt
			json.Unmarshal([]byte(cached), &v)
			trackReceipt(v, boolValue(v.Record.Value, "purged"))
			continue
		}
		origFolder := stringValue(m.Record.Value, "folderId")
		if e = validRecord(tx, u.ID, m.Record); e != nil {
			return e
		}
		serverAltered := stringValue(m.Record.Value, "folderId") != origFolder
		old, oldHash, oe := getRecordWithHash(tx, u.ID, m.Record.ID)
		if oe != nil && oe != sql.ErrNoRows {
			return oe
		}
		if oe == nil && old.Kind != m.Record.Kind {
			return bad("记录类型不可变更")
		}
		v := m.Record
		if oe == nil && v.Kind == "folder" && stringValue(old.Value, "module") != stringValue(v.Value, "module") {
			return bad("文件夹模块不可变更")
		}
		var conflict *record
		unchanged := false
		if oe == nil && boolValue(old.Value, "purged") {
			// Permanent deletion is final for the old ID. A genuinely new offline
			// edit is recoverable under a fresh ID; replaying the old deletion is a no-op.
			if v.DeletedAt == nil {
				copy := v
				copy.ID = randomID()
				copy.Version = 0
				copy.Value = cloneValue(v.Value)
				copy.Value["title"] = stringValue(v.Value, "title") + "（离线恢复副本）"
				copy, e = writeRecord(tx, u.ID, copy)
				if e != nil {
					return e
				}
				conflict = &copy
			}
			v = old
			serverAltered = true
		} else if oe == nil && recordContentHash(v) == oldHash {
			// Content-hash short-circuit: identical payload needs no new version, no conflict copy, and no echo to other devices.
			v = old
			unchanged = true
		} else {
			if oe == nil && old.Version != m.Base && v.Kind != "folder" {
				// Latest committed save wins; keep the displaced server content as a separate record, including edit/delete races.
				if old.DeletedAt == nil || v.DeletedAt == nil {
					copy := old
					copy.ID = randomID()
					copy.DeletedAt = nil
					copy.Value = cloneValue(old.Value)
					copy.Value["title"] = stringValue(old.Value, "title") + "（冲突副本）"
					copy, e = writeRecord(tx, u.ID, copy)
					if e != nil {
						return e
					}
					conflict = &copy
				}
			}
			if v.Kind == "folder" && v.DeletedAt != nil {
				if e = moveFolderMembers(tx, u.ID, v.ID); e != nil {
					return e
				}
			}
			if v.DeletedAt != nil {
				s := now()
				v.DeletedAt = &s
			}
			v, e = writeRecord(tx, u.ID, v)
			if e != nil {
				return e
			}
			if v.Kind == "note" && v.DeletedAt == nil && (oe == sql.ErrNoRows || stringValue(old.Value, "title") != stringValue(v.Value, "title") || !jsonEqual(old.Value["content"], v.Value["content"])) {
				// Keep the first snapshot in a five-minute window and its latest revision, so a restore always has an earlier point.
				var hid, created string
				he := tx.QueryRow("SELECT id,created FROM history WHERE user_id=? AND note_id=? ORDER BY created DESC LIMIT 1", u.ID, v.ID).Scan(&hid, &created)
				raw, _ := json.Marshal(v)
				stamp := now()
				ct, _ := time.Parse(time.RFC3339Nano, created)
				var count int
				tx.QueryRow("SELECT count(*) FROM history WHERE user_id=? AND note_id=?", u.ID, v.ID).Scan(&count)
				if he == nil && time.Since(ct) < 5*time.Minute && count > 1 {
					_, e = tx.Exec("UPDATE history SET record=? WHERE id=?", string(raw), hid)
				} else {
					_, e = tx.Exec("INSERT INTO history(id,user_id,note_id,created,record) VALUES(?,?,?,?,?)", randomID(), u.ID, v.ID, stamp, string(raw))
				}
				if e != nil {
					return e
				}
				_, e = tx.Exec("DELETE FROM history WHERE user_id=? AND note_id=? AND id NOT IN (SELECT id FROM history WHERE user_id=? AND note_id=? ORDER BY created DESC LIMIT 50)", u.ID, v.ID, u.ID, v.ID)
				if e != nil {
					return e
				}
			}
		}
		rr := receipt{OpID: m.OpID, Record: v, Conflict: conflict, Unchanged: unchanged}
		raw, _ := json.Marshal(rr)
		if _, e = tx.Exec("INSERT INTO receipts(user_id,op_id,response,created) VALUES(?,?,?,?)", u.ID, m.OpID, string(raw), now()); e != nil {
			return e
		}
		trackReceipt(rr, serverAltered)
	}
	var nextCursor *int64
	var hasOtherChanges *bool
	if in.Cursor != nil {
		args := []any{u.ID, *in.Cursor}
		query := "SELECT count(*) FROM records WHERE user_id=? AND version>?"
		if len(pushedIDs) > 0 {
			placeholders := make([]string, 0, len(pushedIDs))
			for id := range pushedIDs {
				placeholders = append(placeholders, "?")
				args = append(args, id)
			}
			query += " AND id NOT IN (" + strings.Join(placeholders, ",") + ")"
		}
		var otherCount int
		if e = tx.QueryRow(query, args...).Scan(&otherCount); e != nil {
			return e
		}
		hasOther := otherCount > 0
		hasOtherChanges = &hasOther
		if !hasOther {
			nc := *in.Cursor
			if maxPushedVersion > nc {
				nc = maxPushedVersion
			}
			nextCursor = &nc
		}
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	resp := map[string]any{}
	if in.Compact {
		resp["receipts"] = compactOut
	} else {
		resp["receipts"] = out
	}
	if nextCursor != nil {
		resp["nextCursor"] = *nextCursor
	}
	if hasOtherChanges != nil {
		resp["hasOtherChanges"] = *hasOtherChanges
	}
	output(w, 200, resp)
	return nil
}
func cloneValue(v map[string]any) map[string]any {
	b, _ := json.Marshal(v)
	var out map[string]any
	json.Unmarshal(b, &out)
	return out
}

func moveFolderMembers(tx *sql.Tx, uid, folderID string) error {
	rows, e := tx.Query("SELECT id,kind,version,updated,deleted,payload FROM records WHERE user_id=? AND kind!='folder' AND json_extract(payload,'$.folderId')=?", uid, folderID)
	if e != nil {
		return e
	}
	var members []record
	for rows.Next() {
		v, e := scanRecord(rows)
		if e != nil {
			rows.Close()
			return e
		}
		members = append(members, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, v := range members {
		v.Value["folderId"] = ""
		if _, e = writeRecord(tx, uid, v); e != nil {
			return e
		}
	}
	return nil
}
func jsonEqual(a, b any) bool {
	aa, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(aa) == string(bb)
}
func (a *app) pull(w http.ResponseWriter, r *http.Request, u user) error {
	cursor := intQuery(r, "cursor")
	rows, e := a.db.Query("SELECT id,kind,version,updated,deleted,payload FROM records WHERE user_id=? AND version>? ORDER BY version ASC LIMIT 500", u.ID, cursor)
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []record{}
	for rows.Next() {
		v, e := scanRecord(rows)
		if e != nil {
			return e
		}
		cursor = v.Version
		out = append(out, v)
	}
	if e = rows.Err(); e != nil {
		return e
	}
	output(w, 200, map[string]any{"records": out, "cursor": cursor, "more": len(out) == 500})
	return nil
}
func (a *app) history(w http.ResponseWriter, r *http.Request, u user) error {
	rows, e := a.db.Query("SELECT id,created,record FROM history WHERE user_id=? AND note_id=? ORDER BY created DESC", u.ID, r.PathValue("id"))
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, created, raw string
		rows.Scan(&id, &created, &raw)
		var v record
		json.Unmarshal([]byte(raw), &v)
		out = append(out, map[string]any{"id": id, "createdAt": created, "record": v})
	}
	output(w, 200, out)
	return rows.Err()
}
func (a *app) search(w http.ResponseWriter, r *http.Request, u user) error {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		output(w, 200, []record{})
		return nil
	}
	if len(q) > 500 {
		return bad("关键词过长")
	}
	var rows *sql.Rows
	var e error
	if len([]rune(q)) >= 3 {
		term := "\"" + strings.ReplaceAll(q, "\"", "\"\"") + "\""
		rows, e = a.db.Query(`SELECT r.id,r.kind,r.version,r.updated,r.deleted,r.payload FROM records r JOIN search s ON s.record_id=r.id AND s.user_id=r.user_id WHERE search MATCH ? AND r.user_id=? AND r.deleted IS NULL LIMIT 100`, term, u.ID)
	} else {
		like := "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(q) + "%"
		rows, e = a.db.Query(`SELECT id,kind,version,updated,deleted,payload FROM records WHERE user_id=? AND deleted IS NULL AND kind!='folder' AND (json_extract(payload,'$.title') LIKE ? ESCAPE '\' OR json_extract(payload,'$.plainText') LIKE ? ESCAPE '\' OR json_extract(payload,'$.note') LIKE ? ESCAPE '\') LIMIT 100`, u.ID, like, like, like)
	}
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []record{}
	for rows.Next() {
		v, e := scanRecord(rows)
		if e != nil {
			return e
		}
		out = append(out, v)
	}
	output(w, 200, out)
	return rows.Err()
}

func (a *app) purge(w http.ResponseWriter, r *http.Request, u user) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	v, e := getRecord(tx, u.ID, r.PathValue("id"))
	if e != nil {
		return apiError{404, "记录不存在"}
	}
	if v.DeletedAt == nil {
		return bad("请先移入最近删除")
	}
	// Durable minimal tombstone prevents offline clients from replaying purged content as a normal update.
	v.Value = map[string]any{"purged": true}
	if v.Kind == "folder" {
		return bad("文件夹通过同步删除")
	}
	v, e = writeRecord(tx, u.ID, v)
	if e != nil {
		return e
	}
	for _, q := range []string{"DELETE FROM history WHERE user_id=? AND note_id=?", "DELETE FROM shares WHERE user_id=? AND note_id=?"} {
		if _, e = tx.Exec(q, u.ID, v.ID); e != nil {
			return e
		}
	}
	if e = retireNoteAttachments(tx, u.ID, v.ID); e != nil {
		return e
	}
	// Retain operation IDs with sanitized tombstone responses. Deleting the
	// receipt would turn a network retry of the original create into a new edit.
	rawTombstone, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if _, e = tx.Exec("UPDATE receipts SET response=json_set(response,'$.record',json(?)) WHERE user_id=? AND json_extract(response,'$.record.id')=?", string(rawTombstone), u.ID, v.ID); e != nil {
		return e
	}
	if _, e = tx.Exec("UPDATE receipts SET response=json_remove(response,'$.conflict') WHERE user_id=? AND json_extract(response,'$.conflict.id')=?", u.ID, v.ID); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	a.gcBlobs(u.ID)
	output(w, 200, map[string]bool{"ok": true})
	return nil
}
func (a *app) gcBlobs(uid string) {
	rows, e := a.db.Query("SELECT hash FROM blobs b WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM attachments t WHERE t.user_id=b.user_id AND t.hash=b.hash)", uid)
	if e != nil {
		return
	}
	var hashes []string
	for rows.Next() {
		var h string
		rows.Scan(&h)
		hashes = append(hashes, h)
	}
	rows.Close()
	for _, h := range hashes {
		if _, e = a.db.Exec("DELETE FROM blobs WHERE user_id=? AND hash=?", uid, h); e == nil {
			os.Remove(filepath.Join(a.dir, "blobs", uid, h))
		}
	}
}
func (a *app) cleanup() {
	rows, e := a.db.Query("SELECT user_id,id FROM records WHERE deleted IS NOT NULL AND deleted<? AND kind!='folder' AND COALESCE(json_extract(payload,'$.purged'),0)=0", time.Now().UTC().Add(-30*24*time.Hour).Format(time.RFC3339Nano))
	if e != nil {
		return
	}
	type target struct{ u, id string }
	var targets []target
	for rows.Next() {
		var t target
		rows.Scan(&t.u, &t.id)
		targets = append(targets, t)
	}
	rows.Close()
	for _, t := range targets {
		r, _ := http.NewRequest("DELETE", "/", nil)
		r.SetPathValue("id", t.id)
		if e = a.purge(discardWriter{}, r, user{ID: t.u}); e != nil {
			log.Printf("trash cleanup: %v", e)
		}
	}
	// Prune old idempotency receipts (14 days) so SQLite does not grow unbounded.
	_, _ = a.db.Exec("DELETE FROM receipts WHERE created!='' AND created<?", time.Now().UTC().Add(-14*24*time.Hour).Format(time.RFC3339Nano))
}

type discardWriter struct{}

func (discardWriter) Header() http.Header         { return http.Header{} }
func (discardWriter) Write(b []byte) (int, error) { return len(b), nil }
func (discardWriter) WriteHeader(int)             {}
