package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Conflict copies keep attachment IDs. When a note is purged, transfer its
// attachment metadata to another referring note/history rather than losing a
// file still used by that preserved copy.
func retireNoteAttachments(tx *sql.Tx, uid, noteID string) error {
	rows, e := tx.Query("SELECT id FROM attachments WHERE user_id=? AND note_id=?", uid, noteID)
	if e != nil {
		return e
	}
	var ids []string
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, id := range ids {
		var other string
		e = tx.QueryRow(`SELECT id FROM records WHERE user_id=? AND id!=? AND kind='note' AND COALESCE(json_extract(payload,'$.purged'),0)=0 AND instr(payload,?)>0
 UNION SELECT h.note_id FROM history h JOIN records r ON r.id=h.note_id AND r.user_id=h.user_id WHERE h.user_id=? AND h.note_id!=? AND instr(h.record,?)>0 AND COALESCE(json_extract(r.payload,'$.purged'),0)=0 LIMIT 1`, uid, noteID, id, uid, noteID, id).Scan(&other)
		if e == sql.ErrNoRows {
			_, e = tx.Exec("DELETE FROM attachments WHERE user_id=? AND id=?", uid, id)
		} else if e == nil {
			_, e = tx.Exec("UPDATE attachments SET note_id=? WHERE user_id=? AND id=?", other, uid, id)
		}
		if e != nil {
			return e
		}
	}
	return nil
}

func isSHA256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func (a *app) checkAttachment(w http.ResponseWriter, r *http.Request, u user) error {
	var in struct {
		ID       string `json:"id"`
		NoteID   string `json:"noteId"`
		Hash     string `json:"hash"`
		Filename string `json:"filename"`
	}
	if e := decodeLimit(w, r, &in, 4<<10); e != nil {
		return e
	}
	in.Hash = strings.ToLower(strings.TrimSpace(in.Hash))
	if len(in.ID) < 8 || len(in.ID) > 80 {
		return bad("附件 ID 无效")
	}
	if !isSHA256Hex(in.Hash) {
		return bad("附件哈希无效")
	}
	filename := filepath.Base(strings.ReplaceAll(in.Filename, "\\", "/"))
	if filename == "." || filename == "/" || filename == "" {
		filename = "file"
	}
	if len(filename) > 255 {
		return bad("文件名过长")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var kind string
	var deleted any
	e := a.db.QueryRow("SELECT kind,deleted FROM records WHERE user_id=? AND id=?", u.ID, in.NoteID).Scan(&kind, &deleted)
	if e != nil || kind != "note" || deleted != nil {
		return bad("请先同步这篇备忘")
	}
	var oldUser, oldNote, oldHash string
	if a.db.QueryRow("SELECT user_id,note_id,hash FROM attachments WHERE id=?", in.ID).Scan(&oldUser, &oldNote, &oldHash) == nil {
		if oldUser != u.ID || oldNote != in.NoteID || oldHash != in.Hash {
			return bad("附件 ID 已被使用")
		}
		var size int64
		var mt string
		_ = a.db.QueryRow("SELECT size,mime FROM blobs WHERE user_id=? AND hash=?", u.ID, in.Hash).Scan(&size, &mt)
		output(w, 200, map[string]any{"exists": true, "id": in.ID, "hash": in.Hash, "size": size, "mime": mt})
		return nil
	}
	var size int64
	var mt string
	if e = a.db.QueryRow("SELECT size,mime FROM blobs WHERE user_id=? AND hash=?", u.ID, in.Hash).Scan(&size, &mt); e != nil {
		if e == sql.ErrNoRows {
			output(w, 200, map[string]any{"exists": false})
			return nil
		}
		return e
	}
	if _, e = os.Stat(filepath.Join(a.dir, "blobs", u.ID, in.Hash)); e != nil {
		output(w, 200, map[string]any{"exists": false})
		return nil
	}
	if _, e = a.db.Exec("INSERT INTO attachments(id,user_id,note_id,hash,filename) VALUES(?,?,?,?,?)", in.ID, u.ID, in.NoteID, in.Hash, filename); e != nil {
		return e
	}
	output(w, 200, map[string]any{"exists": true, "id": in.ID, "hash": in.Hash, "size": size, "mime": mt})
	return nil
}

func (a *app) upload(w http.ResponseWriter, r *http.Request, u user) error {
	r.Body = http.MaxBytesReader(w, r.Body, (50<<20)+(1<<20))
	if e := r.ParseMultipartForm(2 << 20); e != nil {
		return bad("文件超过 50MB 或格式错误")
	}
	defer r.MultipartForm.RemoveAll()
	f, h, e := r.FormFile("file")
	if e != nil {
		return bad("请选择文件")
	}
	defer f.Close()
	if h.Size > 50<<20 {
		return bad("单个文件最多 50MB")
	}
	id, note := r.FormValue("id"), r.FormValue("noteId")
	if len(id) < 8 || len(id) > 80 {
		return bad("附件 ID 无效")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var kind string
	var deleted any
	e = a.db.QueryRow("SELECT kind,deleted FROM records WHERE user_id=? AND id=?", u.ID, note).Scan(&kind, &deleted)
	if e != nil || kind != "note" || deleted != nil {
		return bad("请先同步这篇备忘")
	}
	dir := filepath.Join(a.dir, "blobs", u.ID)
	if e = os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	tmp, e := os.CreateTemp(dir, "upload-")
	if e != nil {
		return e
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	hasher := sha256.New()
	size, e := io.Copy(io.MultiWriter(tmp, hasher), io.LimitReader(f, (50<<20)+1))
	if e != nil {
		return e
	}
	if size > 50<<20 {
		return bad("单个文件最多 50MB")
	}
	hash := hex.EncodeToString(hasher.Sum(nil))
	if _, e = tmp.Seek(0, 0); e != nil {
		return e
	}
	head := make([]byte, 512)
	n, _ := tmp.Read(head)
	mt := http.DetectContentType(head[:n])
	if mt == "application/octet-stream" {
		if t := mime.TypeByExtension(filepath.Ext(h.Filename)); t != "" {
			mt = t
		}
	}
	filename := filepath.Base(strings.ReplaceAll(h.Filename, "\\", "/"))
	if len(filename) > 255 {
		return bad("文件名过长")
	}
	var oldUser, oldNote, oldHash string
	if a.db.QueryRow("SELECT user_id,note_id,hash FROM attachments WHERE id=?", id).Scan(&oldUser, &oldNote, &oldHash) == nil {
		if oldUser != u.ID || oldNote != note || oldHash != hash {
			return bad("附件 ID 已被使用")
		}
		output(w, 200, map[string]any{"id": id, "hash": hash, "size": size, "mime": mt})
		return nil
	}
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var exists int
	tx.QueryRow("SELECT count(*) FROM blobs WHERE user_id=? AND hash=?", u.ID, hash).Scan(&exists)
	if exists == 0 {
		var used, quota int64
		if e = tx.QueryRow("SELECT quota,COALESCE((SELECT sum(size) FROM blobs WHERE user_id=?),0) FROM users WHERE id=?", u.ID, u.ID).Scan(&quota, &used); e != nil {
			return e
		}
		if used+size > quota {
			return apiError{413, "账号存储空间不足，请联系管理员调整配额"}
		}
		if e = tmp.Close(); e != nil {
			return e
		}
		if e = os.Rename(tmp.Name(), filepath.Join(dir, hash)); e != nil {
			return e
		}
		if _, e = tx.Exec("INSERT INTO blobs(user_id,hash,size,mime) VALUES(?,?,?,?)", u.ID, hash, size, mt); e != nil {
			return e
		}
	}
	if _, e = tx.Exec("INSERT INTO attachments(id,user_id,note_id,hash,filename) VALUES(?,?,?,?,?)", id, u.ID, note, hash, filename); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	output(w, 200, map[string]any{"id": id, "hash": hash, "size": size, "mime": mt})
	return nil
}
func (a *app) serveAttachment(w http.ResponseWriter, r *http.Request, uid, id string) error {
	var hash, filename, mt string
	e := a.db.QueryRow("SELECT t.hash,t.filename,b.mime FROM attachments t JOIN blobs b ON b.user_id=t.user_id AND b.hash=t.hash WHERE t.user_id=? AND t.id=?", uid, id).Scan(&hash, &filename, &mt)
	if e != nil {
		return apiError{404, "附件不存在"}
	}
	w.Header().Set("Content-Type", mt)
	disposition := "attachment"
	if mt == "image/png" || mt == "image/jpeg" || mt == "image/webp" || mt == "image/gif" {
		disposition = "inline"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": filename}))
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	http.ServeFile(w, r, filepath.Join(a.dir, "blobs", uid, hash))
	return nil
}
func (a *app) download(w http.ResponseWriter, r *http.Request, u user) error {
	return a.serveAttachment(w, r, u.ID, r.PathValue("id"))
}
func (a *app) removeAttachment(w http.ResponseWriter, r *http.Request, u user) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, e := a.db.Exec("DELETE FROM attachments WHERE user_id=? AND id=?", u.ID, r.PathValue("id")); e != nil {
		return e
	}
	a.gcBlobs(u.ID)
	output(w, 200, map[string]bool{"ok": true})
	return nil
}
func (a *app) listShares(w http.ResponseWriter, r *http.Request, u user) error {
	rows, e := a.db.Query("SELECT token,created FROM shares WHERE user_id=? AND note_id=?", u.ID, r.PathValue("id"))
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []map[string]string{}
	for rows.Next() {
		var token, created string
		rows.Scan(&token, &created)
		out = append(out, map[string]string{"token": token, "createdAt": created})
	}
	output(w, 200, out)
	return rows.Err()
}
func (a *app) createShare(w http.ResponseWriter, r *http.Request, u user) error {
	var kind string
	var deleted any
	var payload string
	e := a.db.QueryRow("SELECT kind,deleted,payload FROM records WHERE user_id=? AND id=?", u.ID, r.PathValue("id")).Scan(&kind, &deleted, &payload)
	if e != nil || kind != "note" || deleted != nil {
		return bad("请先同步这篇备忘")
	}
	token := randomToken()
	if _, e = a.db.Exec("INSERT INTO shares(token,user_id,note_id,created) VALUES(?,?,?,?)", token, u.ID, r.PathValue("id"), now()); e != nil {
		return e
	}
	output(w, 201, map[string]string{"token": token})
	return nil
}
func (a *app) revokeShare(w http.ResponseWriter, r *http.Request, u user) error {
	_, e := a.db.Exec("DELETE FROM shares WHERE user_id=? AND token=?", u.ID, r.PathValue("token"))
	if e == nil {
		output(w, 200, map[string]bool{"ok": true})
	}
	return e
}
func (a *app) shared(token string) (record, string, error) {
	var uid, nid string
	var v record
	e := a.db.QueryRow("SELECT s.user_id,s.note_id FROM shares s JOIN users u ON u.id=s.user_id AND u.disabled=0 WHERE s.token=?", token).Scan(&uid, &nid)
	if e != nil {
		return v, "", apiError{404, "分享已撤销或不存在"}
	}
	v, e = scanRecord(a.db.QueryRow("SELECT id,kind,version,updated,deleted,payload FROM records WHERE user_id=? AND id=?", uid, nid))
	if e != nil || v.DeletedAt != nil {
		return v, "", apiError{404, "分享已撤销或不存在"}
	}
	return v, uid, nil
}
func (a *app) publicShare(w http.ResponseWriter, r *http.Request) {
	v, _, e := a.shared(r.PathValue("token"))
	if e != nil {
		fail(w, e)
		return
	}
	output(w, 200, v)
}
func (a *app) publicAttachment(w http.ResponseWriter, r *http.Request) {
	v, uid, e := a.shared(r.PathValue("token"))
	if e != nil {
		fail(w, e)
		return
	}
	if !referencesAttachment(v.Value["content"], r.PathValue("id")) {
		fail(w, apiError{404, "附件不存在"})
		return
	}
	if e = a.serveAttachment(w, r, uid, r.PathValue("id")); e != nil {
		fail(w, e)
	}
}

// Scope public downloads to attachments actually embedded in the currently
// shared note. This also lets a conflict copy retain its original attachments.
func referencesAttachment(value any, id string) bool {
	node, ok := value.(map[string]any)
	if !ok {
		return false
	}
	typ, _ := node["type"].(string)
	if typ == "image" || typ == "attachment" {
		attrs, _ := node["attrs"].(map[string]any)
		if attrs["attachmentId"] == id {
			return true
		}
	}
	children, _ := node["content"].([]any)
	for _, child := range children {
		if referencesAttachment(child, id) {
			return true
		}
	}
	return false
}

func (a *app) devices(w http.ResponseWriter, r *http.Request, u user) error {
	rows, e := a.db.Query("SELECT id,name,last_seen,token FROM devices WHERE user_id=? ORDER BY last_seen DESC", u.ID)
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []map[string]any{}
	current := hashToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	for rows.Next() {
		var id, name, seen, token string
		rows.Scan(&id, &name, &seen, &token)
		out = append(out, map[string]any{"id": id, "name": name, "lastSeen": seen, "current": current == token})
	}
	output(w, 200, out)
	return rows.Err()
}
func (a *app) revokeDevice(w http.ResponseWriter, r *http.Request, u user) error {
	_, e := a.db.Exec("DELETE FROM devices WHERE user_id=? AND id=?", u.ID, r.PathValue("id"))
	if e == nil {
		output(w, 200, map[string]bool{"ok": true})
	}
	return e
}
func (a *app) users(w http.ResponseWriter, r *http.Request, u user) error {
	rows, e := a.db.Query("SELECT id,username,admin,quota,disabled,COALESCE((SELECT sum(size) FROM blobs WHERE user_id=users.id),0) FROM users ORDER BY username")
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []user{}
	for rows.Next() {
		var v user
		rows.Scan(&v.ID, &v.Username, &v.Admin, &v.Quota, &v.Disabled, &v.Used)
		out = append(out, v)
	}
	output(w, 200, out)
	return rows.Err()
}
func (a *app) createUser(w http.ResponseWriter, r *http.Request, u user) error {
	var in struct {
		Username, Password string
		Quota              int64
	}
	if e := decodeLimit(w, r, &in, 4<<10); e != nil {
		return e
	}
	in.Username = strings.TrimSpace(in.Username)
	if len(in.Username) < 2 || len(in.Username) > 64 || len(in.Password) < 12 || len(in.Password) > 256 {
		return bad("用户名 2–64 字节，密码 12–256 字节")
	}
	if in.Quota <= 0 {
		in.Quota = 2 << 30
	}
	id := randomID()
	if _, e := a.db.Exec("INSERT INTO users(id,username,pass,quota) VALUES(?,?,?,?)", id, in.Username, passwordHash(in.Password), in.Quota); e != nil {
		if strings.Contains(e.Error(), "UNIQUE") {
			return bad("用户名已存在")
		}
		return e
	}
	output(w, 201, map[string]string{"id": id})
	return nil
}
func (a *app) updateUser(w http.ResponseWriter, r *http.Request, u user) error {
	var in struct {
		Password *string
		Quota    *int64
		Disabled *bool
	}
	if e := decodeLimit(w, r, &in, 4<<10); e != nil {
		return e
	}
	id := r.PathValue("id")
	if in.Password != nil && (len(*in.Password) < 12 || len(*in.Password) > 256) {
		return bad("密码需为 12–256 字节")
	}
	if in.Quota != nil && *in.Quota <= 0 {
		return bad("配额需大于 0")
	}
	if id == u.ID && in.Disabled != nil && *in.Disabled {
		return bad("请保留当前管理员账号启用")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var exists int
	tx.QueryRow("SELECT count(*) FROM users WHERE id=?", id).Scan(&exists)
	if exists == 0 {
		return apiError{404, "用户不存在"}
	}
	if in.Password != nil {
		if _, e = tx.Exec("UPDATE users SET pass=? WHERE id=?", passwordHash(*in.Password), id); e != nil {
			return e
		}
		if _, e = tx.Exec("DELETE FROM devices WHERE user_id=?", id); e != nil {
			return e
		}
	}
	if in.Quota != nil {
		if _, e = tx.Exec("UPDATE users SET quota=? WHERE id=?", *in.Quota, id); e != nil {
			return e
		}
	}
	if in.Disabled != nil {
		if _, e = tx.Exec("UPDATE users SET disabled=? WHERE id=?", *in.Disabled, id); e != nil {
			return e
		}
		if *in.Disabled {
			if _, e = tx.Exec("DELETE FROM devices WHERE user_id=?", id); e != nil {
				return e
			}
		}
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	output(w, 200, map[string]bool{"ok": true})
	return nil
}
func (a *app) deleteUser(w http.ResponseWriter, r *http.Request, u user) error {
	id := r.PathValue("id")
	if id == u.ID {
		return bad("不能删除当前管理员账号")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var isAdmin bool
	if e = tx.QueryRow("SELECT admin FROM users WHERE id=?", id).Scan(&isAdmin); e != nil {
		if e == sql.ErrNoRows {
			return apiError{404, "用户不存在"}
		}
		return e
	}
	if isAdmin {
		return bad("不能删除管理员账号")
	}
	for _, q := range []string{
		"DELETE FROM shares WHERE user_id=?",
		"DELETE FROM attachments WHERE user_id=?",
		"DELETE FROM blobs WHERE user_id=?",
		"DELETE FROM history WHERE user_id=?",
		"DELETE FROM receipts WHERE user_id=?",
		"DELETE FROM changes WHERE user_id=?",
		"DELETE FROM search WHERE user_id=?",
		"DELETE FROM records WHERE user_id=?",
		"DELETE FROM api_keys WHERE user_id=?",
		"DELETE FROM devices WHERE user_id=?",
		"DELETE FROM users WHERE id=?",
	} {
		if _, e = tx.Exec(q, id); e != nil {
			return e
		}
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	_ = os.RemoveAll(filepath.Join(a.dir, "blobs", id))
	output(w, 200, map[string]bool{"ok": true})
	return nil
}
