package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type testClient struct {
	t     *testing.T
	a     *app
	h     http.Handler
	token string
	uid   string
}

func newTestClient(t *testing.T) *testClient {
	t.Helper()
	a, e := openApp(t.TempDir(), t.TempDir(), "https://notes.example.test")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { a.db.Close() })
	if e = a.bootstrap("admin", "correct-horse-battery"); e != nil {
		t.Fatal(e)
	}
	c := &testClient{t: t, a: a, h: a.routes()}
	r := c.request("POST", "/api/login", map[string]any{"username": "admin", "password": "correct-horse-battery", "device": "test"})
	var login struct {
		Token string
		User  user
	}
	mustJSON(t, r, 200, &login)
	c.token = login.Token
	c.uid = login.User.ID
	return c
}
func (c *testClient) request(method, path string, body any) *httptest.ResponseRecorder {
	c.t.Helper()
	var b io.Reader
	if body != nil {
		raw, e := json.Marshal(body)
		if e != nil {
			c.t.Fatal(e)
		}
		b = bytes.NewReader(raw)
	}
	r := httptest.NewRequest(method, path, b)
	r.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		r.Header.Set("Authorization", "Bearer "+c.token)
	}
	w := httptest.NewRecorder()
	c.h.ServeHTTP(w, r)
	return w
}
func mustJSON(t *testing.T, w *httptest.ResponseRecorder, status int, v any) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("HTTP %d, expected %d: %s", w.Code, status, w.Body.String())
	}
	if v != nil {
		if e := json.Unmarshal(w.Body.Bytes(), v); e != nil {
			t.Fatalf("decode: %v: %s", e, w.Body.String())
		}
	}
}
func note(id, title, body string) record {
	return record{ID: id, Kind: "note", Value: map[string]any{"title": title, "plainText": body, "content": map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": body}}}}}}}
}
func (c *testClient) mutate(v record, base int64, op string) receipt {
	c.t.Helper()
	var result struct{ Receipts []receipt }
	mustJSON(c.t, c.request("POST", "/api/sync", map[string]any{"mutations": []mutation{{OpID: op, Base: base, Record: v}}}), 200, &result)
	if len(result.Receipts) != 1 {
		c.t.Fatal("expected one receipt")
	}
	return result.Receipts[0]
}
func (c *testClient) push(v record, base int64) receipt { return c.mutate(v, base, randomID()) }
func (c *testClient) records() []record {
	c.t.Helper()
	var out struct{ Records []record }
	mustJSON(c.t, c.request("GET", "/api/changes", nil), 200, &out)
	return out.Records
}
func (c *testClient) other(username string) *testClient {
	c.t.Helper()
	mustJSON(c.t, c.request("POST", "/api/admin/users", map[string]any{"username": username, "password": "another-strong-password"}), 201, nil)
	other := &testClient{t: c.t, a: c.a, h: c.h}
	var login struct {
		Token string
		User  user
	}
	mustJSON(c.t, other.request("POST", "/api/login", map[string]any{"username": username, "password": "another-strong-password", "device": "other"}), 200, &login)
	other.token = login.Token
	other.uid = login.User.ID
	return other
}
func (c *testClient) upload(id, noteID, filename, content string) *httptest.ResponseRecorder {
	c.t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, e := writer.CreateFormFile("file", filename)
	if e != nil {
		c.t.Fatal(e)
	}
	io.WriteString(part, content)
	writer.WriteField("id", id)
	writer.WriteField("noteId", noteID)
	writer.Close()
	r := httptest.NewRequest("POST", "/api/attachments", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("Authorization", "Bearer "+c.token)
	w := httptest.NewRecorder()
	c.h.ServeHTTP(w, r)
	return w
}
func deleted(r record) record { s := now(); r.DeletedAt = &s; return r }

func TestSyncConflictIdempotencyAndIsolation(t *testing.T) {
	c := newTestClient(t)
	other := c.other("second-user")
	first := c.push(note("note-0001", "原始标题", "原始内容"), 0)
	left := first.Record
	left.Value = cloneValue(left.Value)
	left.Value["plainText"] = "电脑修改"
	left.Value["content"] = map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": "电脑修改"}}}}}
	saved := c.push(left, first.Record.Version)
	right := note(first.Record.ID, "手机标题", "手机离线修改")
	result := c.mutate(right, first.Record.Version, "op-offline-phone")
	if result.Conflict == nil || stringValue(result.Conflict.Value, "plainText") != "电脑修改" || !strings.HasSuffix(stringValue(result.Conflict.Value, "title"), "（冲突副本）") {
		t.Fatalf("missing displaced content: %#v", result)
	}
	if stringValue(result.Record.Value, "plainText") != "手机离线修改" || result.Record.Version <= saved.Record.Version {
		t.Fatal("latest commit did not win")
	}
	count := len(c.records())
	again := c.mutate(right, first.Record.Version, "op-offline-phone")
	if again.Record.Version != result.Record.Version || len(c.records()) != count {
		t.Fatal("retry duplicated a mutation")
	}
	if len(other.records()) != 0 {
		t.Fatal("another user's changes leaked")
	}
	var hist []map[string]any
	mustJSON(t, other.request("GET", "/api/history/"+first.Record.ID, nil), 200, &hist)
	if len(hist) > 0 {
		t.Fatal("history leaked")
	}
	mustJSON(t, other.request("DELETE", "/api/records/"+first.Record.ID, nil), 404, nil)
	mustJSON(t, other.request("GET", "/api/admin/users", nil), 403, nil)
}

func TestConcurrentEditsPreserveEveryVersion(t *testing.T) {
	c := newTestClient(t)
	start := c.push(note("concurrent-note", "开始", "base"), 0)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			v := note("concurrent-note", fmt.Sprint("标题", i), fmt.Sprint("body", i))
			raw, _ := json.Marshal(map[string]any{"mutations": []mutation{{OpID: fmt.Sprintf("concurrent-%d", i), Base: start.Record.Version, Record: v}}})
			r := httptest.NewRequest("POST", "/api/sync", bytes.NewReader(raw))
			r.Header.Set("Authorization", "Bearer "+c.token)
			w := httptest.NewRecorder()
			c.h.ServeHTTP(w, r)
			if w.Code != 200 {
				t.Errorf("concurrent save: %d %s", w.Code, w.Body.String())
			}
		}(i)
	}
	wg.Wait()
	var n int
	c.a.db.QueryRow("SELECT count(*) FROM records WHERE user_id=? AND kind='note'", c.uid).Scan(&n)
	if n != 8 {
		t.Fatalf("want 8 preserved versions, got %d", n)
	}
}

func TestFolderDeletionAndStaleReferences(t *testing.T) {
	c := newTestClient(t)
	folder := c.push(record{ID: "folder-note-one", Kind: "folder", Value: map[string]any{"name": "工作", "module": "note"}}, 0)
	initial := note("folder-member", "文件夹成员", "hello")
	initial.Value["folderId"] = folder.Record.ID
	saved := c.push(initial, 0)
	todo := record{ID: "wrong-module", Kind: "todo", Value: map[string]any{"title": "待办", "folderId": folder.Record.ID}}
	mustJSON(t, c.request("POST", "/api/sync", map[string]any{"mutations": []mutation{{OpID: randomID(), Record: todo}}}), 400, nil)
	c.push(deleted(folder.Record), folder.Record.Version)
	var payload string
	if e := c.a.db.QueryRow("SELECT payload FROM records WHERE user_id=? AND id=?", c.uid, initial.ID).Scan(&payload); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(payload, folder.Record.ID) {
		t.Fatal("deleted folder left dangling membership")
	}
	stale := saved.Record
	stale.Value = cloneValue(stale.Value)
	stale.Value["plainText"] = "offline update"
	result := c.push(stale, saved.Record.Version)
	if stringValue(result.Record.Value, "folderId") != "" {
		t.Fatal("stale folder edit should move to default")
	}
	other := c.other("folder-other-user")
	stolen := note("stolen-folder-reference", "bad", "body")
	stolen.Value["folderId"] = folder.Record.ID
	mustJSON(t, other.request("POST", "/api/sync", map[string]any{"mutations": []mutation{{OpID: randomID(), Record: stolen}}}), 400, nil)
}

func TestHistorySearchTrashAndPermanentDelete(t *testing.T) {
	c := newTestClient(t)
	first := c.mutate(note("history-note", "门诊记录", "需要保存的独特内容"), 0, "original-create-op")
	changed := note(first.Record.ID, "门诊记录更新", "需要保存的新版本内容")
	second := c.push(changed, first.Record.Version)
	third := c.push(note(first.Record.ID, "门诊记录再次更新", "需要保存的第三次内容"), second.Record.Version)
	var hist []struct{ Record record }
	mustJSON(t, c.request("GET", "/api/history/"+first.Record.ID, nil), 200, &hist)
	if len(hist) != 2 {
		t.Fatalf("history window should preserve original and latest: %d", len(hist))
	}
	if stringValue(hist[0].Record.Value, "plainText") != "需要保存的第三次内容" || stringValue(hist[1].Record.Value, "plainText") != "需要保存的独特内容" {
		t.Fatal("history lost initial or latest snapshot")
	}
	for _, q := range []string{"门诊", "第三次内容", "门"} {
		var hits []record
		mustJSON(t, c.request("GET", "/api/search?q="+url.QueryEscape(q), nil), 200, &hits)
		if len(hits) != 1 {
			t.Fatalf("Chinese search %s: %d hits", q, len(hits))
		}
	}
	trash := c.push(deleted(third.Record), third.Record.Version)
	var hits []record
	mustJSON(t, c.request("GET", "/api/search?q="+url.QueryEscape("门诊"), nil), 200, &hits)
	if len(hits) != 0 {
		t.Fatal("trashed record appeared in search")
	}
	restore := trash.Record
	restore.DeletedAt = nil
	restored := c.push(restore, trash.Record.Version)
	if restored.Record.DeletedAt != nil {
		t.Fatal("restore failed")
	}
	trash = c.push(deleted(restored.Record), restored.Record.Version)
	mustJSON(t, c.request("DELETE", "/api/records/"+first.Record.ID, nil), 200, nil)
	var all []record = c.records()
	if len(all) != 1 || !boolValue(all[0].Value, "purged") {
		t.Fatal("permanent deletion retained original pull bodies")
	}
	mustJSON(t, c.request("GET", "/api/history/"+first.Record.ID, nil), 200, &hist)
	if len(hist) != 0 {
		t.Fatal("permanent deletion retained history")
	}
	createRetry := c.mutate(note("history-note", "门诊记录", "需要保存的独特内容"), 0, "original-create-op")
	if !boolValue(createRetry.Record.Value, "purged") || createRetry.Conflict != nil || len(c.records()) != 1 {
		t.Fatal("retrying original create resurrected permanently deleted content")
	}
	replay := c.push(trash.Record, trash.Record.Version)
	if !boolValue(replay.Record.Value, "purged") || replay.Conflict != nil {
		t.Fatal("replayed deletion resurrected content")
	}
	offline := c.push(note(first.Record.ID, "new work", "fresh offline edit"), third.Record.Version)
	if !boolValue(offline.Record.Value, "purged") || offline.Conflict == nil || offline.Conflict.ID == first.Record.ID || stringValue(offline.Conflict.Value, "plainText") != "fresh offline edit" {
		t.Fatal("offline work should recover under a new ID while old ID stays purged")
	}
}

func TestAttachmentsQuotaDedupShareScopeAndConflictRetention(t *testing.T) {
	c := newTestClient(t)
	other := c.other("files-other-user")
	r := note("attachment-note", "附件备忘", "body")
	r.Value["content"] = map[string]any{"type": "doc", "content": []any{map[string]any{"type": "attachment", "attrs": map[string]any{"attachmentId": "attachment-one", "name": "file.txt", "size": 10}}}}
	first := c.push(r, 0)
	c.a.db.Exec("UPDATE users SET quota=10 WHERE id=?", c.uid)
	mustJSON(t, c.upload("attachment-one", r.ID, "file.txt", "1234567890"), 200, nil)
	mustJSON(t, c.upload("attachment-one", r.ID, "file.txt", "1234567890"), 200, nil)
	mustJSON(t, c.upload("attachment-two", r.ID, "second.txt", "1234567890"), 200, nil)
	mustJSON(t, c.upload("attachment-three", r.ID, "extra.txt", "abcdefghij"), 413, nil)
	var me user
	mustJSON(t, c.request("GET", "/api/me", nil), 200, &me)
	if me.Used != 10 {
		t.Fatalf("dedup charged twice: %d", me.Used)
	}
	mustJSON(t, other.request("GET", "/api/attachments/attachment-one", nil), 404, nil)
	mustJSON(t, other.upload("steal-attachment", r.ID, "steal.txt", "x"), 400, nil)
	var share struct{ Token string }
	mustJSON(t, c.request("POST", "/api/shares/"+r.ID, nil), 201, &share)
	public := &testClient{t: t, a: c.a, h: c.h}
	w := public.request("GET", "/api/public/"+share.Token+"/attachments/attachment-one", nil)
	if w.Code != 200 || w.Body.String() != "1234567890" {
		t.Fatal("public attachment unavailable")
	}
	mustJSON(t, public.request("GET", "/api/public/"+share.Token+"/attachments/attachment-two", nil), 404, nil)
	// A conflict copy shares the same referenced asset; purging the old original keeps it alive.
	c.push(note(r.ID, "new version", "new content without attachment"), first.Record.Version)
	conflict := c.push(note(r.ID, "another offline version", "latest body"), first.Record.Version)
	if conflict.Conflict == nil {
		t.Fatal("missing conflict")
	}
	// Ensure a new conflict copy of the original attachment-bearing content.
	originalAgain := c.push(r, 0)
	copyResult := c.push(note(r.ID, "last", "last"), 0)
	if copyResult.Conflict == nil {
		t.Fatal("missing asset conflict")
	}
	copyID := copyResult.Conflict.ID
	_ = originalAgain
	var copyShare struct{ Token string }
	mustJSON(t, c.request("POST", "/api/shares/"+copyID, nil), 201, &copyShare)
	current := copyResult.Record
	trash := c.push(deleted(current), current.Version)
	_ = trash
	mustJSON(t, c.request("DELETE", "/api/records/"+r.ID, nil), 200, nil)
	if w = public.request("GET", "/api/public/"+copyShare.Token+"/attachments/attachment-one", nil); w.Code != 200 || w.Body.String() != "1234567890" {
		t.Fatalf("purging original lost conflict copy asset: %d %s", w.Code, w.Body.String())
	}
	mustJSON(t, c.request("DELETE", "/api/shares/"+copyShare.Token, nil), 200, nil)
	mustJSON(t, public.request("GET", "/api/public/"+copyShare.Token, nil), 404, nil)
}

func TestAdminPasswordResetDisablesDevicesAndUsers(t *testing.T) {
	c := newTestClient(t)
	other := c.other("admin-managed-user")
	var devices []map[string]any
	mustJSON(t, other.request("GET", "/api/devices", nil), 200, &devices)
	if len(devices) != 1 || devices[0]["current"] != true {
		t.Fatal("device listing incorrect")
	}
	mustJSON(t, c.request("PATCH", "/api/admin/users/"+other.uid, map[string]any{"password": "replacement-strong-password", "quota": 1024}), 200, nil)
	mustJSON(t, other.request("GET", "/api/me", nil), 401, nil)
	other.token = ""
	var login struct {
		Token string
		User  user
	}
	mustJSON(t, other.request("POST", "/api/login", map[string]any{"username": "admin-managed-user", "password": "replacement-strong-password"}), 200, &login)
	other.token = login.Token
	if login.User.Quota != 1024 {
		t.Fatal("quota update missing")
	}
	mustJSON(t, c.request("PATCH", "/api/admin/users/"+other.uid, map[string]any{"disabled": true}), 200, nil)
	mustJSON(t, other.request("GET", "/api/me", nil), 401, nil)
	mustJSON(t, c.request("PATCH", "/api/admin/users/"+c.uid, map[string]any{"disabled": true}), 400, nil)
	mustJSON(t, c.request("PATCH", "/api/admin/users/"+other.uid, map[string]any{"disabled": false}), 200, nil)
	other.token = ""
	mustJSON(t, other.request("POST", "/api/login", map[string]any{"username": "admin-managed-user", "password": "replacement-strong-password"}), 200, &login)
	other.token = login.Token
	mustJSON(t, other.request("GET", "/api/devices", nil), 200, &devices)
	mustJSON(t, other.request("DELETE", "/api/devices/"+devices[0]["id"].(string), nil), 200, nil)
	mustJSON(t, other.request("GET", "/api/me", nil), 401, nil)
}

func TestExpiredTrashCleanupAndBootstrapSafety(t *testing.T) {
	c := newTestClient(t)
	saved := c.push(note("expired-trash-note", "old note", "body"), 0)
	c.push(deleted(saved.Record), saved.Record.Version)
	past := time.Now().UTC().Add(-31 * 24 * time.Hour).Format(time.RFC3339Nano)
	c.a.db.Exec("UPDATE records SET deleted=? WHERE user_id=? AND id=?", past, c.uid, saved.Record.ID)
	c.a.cleanup()
	var payload string
	c.a.db.QueryRow("SELECT payload FROM records WHERE user_id=? AND id=?", c.uid, saved.Record.ID).Scan(&payload)
	if payload != "{\"purged\":true}" {
		t.Fatal("expired trash not purged")
	}
	a, e := openApp(t.TempDir(), t.TempDir(), "")
	if e != nil {
		t.Fatal(e)
	}
	defer a.db.Close()
	if e = a.bootstrap("admin", "weak"); e == nil {
		t.Fatal("weak bootstrap password accepted")
	}
}

func TestCORSAndMalformedRequests(t *testing.T) {
	c := newTestClient(t)
	for _, origin := range []string{"https://localhost", "capacitor://localhost", "https://notes.example.test"} {
		r := httptest.NewRequest("OPTIONS", "/api/sync", nil)
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		c.h.ServeHTTP(w, r)
		if w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") != origin {
			t.Fatalf("CORS rejected app origin: %s", origin)
		}
	}
	r := httptest.NewRequest("OPTIONS", "/api/sync", nil)
	r.Header.Set("Origin", "https://hostile.example")
	w := httptest.NewRecorder()
	c.h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("unexpected cross-origin access")
	}
	r = httptest.NewRequest("POST", "/api/sync", strings.NewReader("{garbled"))
	r.Header.Set("Authorization", "Bearer "+c.token)
	w = httptest.NewRecorder()
	c.h.ServeHTTP(w, r)
	mustJSON(t, w, 400, nil)
	mustJSON(t, c.request("GET", "/api/missing", nil), 404, nil)
}

func TestPublicShareAndSPARoutes(t *testing.T) {
	c := newTestClient(t)
	index := "<!doctype html><html lang=\"zh-CN\"><body>yonote app shell</body></html>"
	if e := os.WriteFile(filepath.Join(c.a.web, "index.html"), []byte(index), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(c.a.web, "app.js"), []byte("export const app = 'yonote';"), 0600); e != nil {
		t.Fatal(e)
	}
	saved := c.push(note("public-page-note", "分享标题", "公开正文"), 0)
	var link struct{ Token string }
	mustJSON(t, c.request("POST", "/api/shares/"+saved.Record.ID, nil), 201, &link)
	public := &testClient{t: t, a: c.a, h: c.h}
	var shared record
	mustJSON(t, public.request("GET", "/api/public/"+link.Token, nil), 200, &shared)
	if stringValue(shared.Value, "plainText") != "公开正文" {
		t.Fatal("public API did not return shared content")
	}
	for _, path := range []string{"/", "/s/" + link.Token} {
		w := public.request("GET", path, nil)
		if w.Code != 200 || w.Body.String() != index {
			t.Fatalf("SPA route %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	w := public.request("GET", "/app.js", nil)
	if w.Code != 200 || w.Body.String() != "export const app = 'yonote';" {
		t.Fatal("static assets did not resolve under configured web root")
	}
	mustJSON(t, public.request("GET", "/api/me", nil), 401, nil)
	mustJSON(t, c.request("DELETE", "/api/shares/"+link.Token, nil), 200, nil)
	mustJSON(t, public.request("GET", "/api/public/"+link.Token, nil), 404, nil)
}

func TestAdminDeleteUserAndKeyPrefix(t *testing.T) {
	c := newTestClient(t)
	other := c.other("temp-delete-user")
	saved := other.push(note("temp-user-note-01", "临时笔记", "将被清理"), 0)
	var share struct{ Token string }
	mustJSON(t, other.request("POST", "/api/shares/"+saved.Record.ID, nil), 201, &share)
	var createdKey struct {
		Key  string     `json:"key"`
		Item apiKeyInfo `json:"item"`
	}
	mustJSON(t, other.request("POST", "/api/keys", map[string]any{"name": "bot", "scopes": []string{"read"}}), 201, &createdKey)
	if len(createdKey.Item.Prefix) != 6 || createdKey.Item.Prefix != createdKey.Key[:6] {
		t.Fatalf("expected 6-char key prefix, got %q for %q", createdKey.Item.Prefix, createdKey.Key)
	}

	// Non-admin cannot delete accounts.
	mustJSON(t, other.request("DELETE", "/api/admin/users/"+c.uid, nil), 403, nil)
	// Admin cannot delete self.
	mustJSON(t, c.request("DELETE", "/api/admin/users/"+c.uid, nil), 400, nil)
	// Missing user returns 404.
	mustJSON(t, c.request("DELETE", "/api/admin/users/nonexistent-id", nil), 404, nil)

	// Delete target user and verify cascade cleanup.
	mustJSON(t, c.request("DELETE", "/api/admin/users/"+other.uid, nil), 200, nil)
	mustJSON(t, other.request("GET", "/api/me", nil), 401, nil)
	var users []user
	mustJSON(t, c.request("GET", "/api/admin/users", nil), 200, &users)
	for _, u := range users {
		if u.ID == other.uid {
			t.Fatal("deleted user still listed")
		}
	}
	var remaining int
	c.a.db.QueryRow("SELECT count(*) FROM records WHERE user_id=?", other.uid).Scan(&remaining)
	if remaining != 0 {
		t.Fatalf("expected 0 records for deleted user, got %d", remaining)
	}
}

func TestSyncStateDeltaHashShortCircuitCompactAndInstantDedup(t *testing.T) {
	c := newTestClient(t)

	// 1. Multiple edits to one note produce only ONE latest record on full pull from cursor=0.
	first := c.push(note("delta-note-01", "版本1", "内容1"), 0)
	curVer := first.Record.Version
	for i := 2; i <= 5; i++ {
		res := c.push(note("delta-note-01", fmt.Sprintf("版本%d", i), fmt.Sprintf("内容%d", i)), curVer)
		curVer = res.Record.Version
	}
	pulled := c.records()
	if len(pulled) != 1 || pulled[0].Version != curVer || stringValue(pulled[0].Value, "title") != "版本5" {
		t.Fatalf("expected 1 latest record on cursor=0 pull, got %d: %#v", len(pulled), pulled)
	}

	// 2. Content-hash short-circuit: pushing identical content (even with stale base) does not bump version or create conflict.
	var shortResp struct {
		Receipts        []compactReceipt `json:"receipts"`
		NextCursor      *int64           `json:"nextCursor"`
		HasOtherChanges *bool            `json:"hasOtherChanges"`
	}
	sameNote := note("delta-note-01", "版本5", "内容5")
	mustJSON(t, c.request("POST", "/api/sync", map[string]any{
		"mutations": []mutation{{OpID: randomID(), Base: 1, Record: sameNote}},
		"cursor":    curVer,
		"compact":   true,
	}), 200, &shortResp)
	if len(shortResp.Receipts) != 1 || !shortResp.Receipts[0].Unchanged || shortResp.Receipts[0].Version != curVer {
		t.Fatalf("expected unchanged short-circuit at version %d, got %#v", curVer, shortResp.Receipts)
	}
	if shortResp.Receipts[0].Record != nil || shortResp.Receipts[0].Conflict != nil {
		t.Fatalf("compact unchanged receipt should omit body and conflict: %#v", shortResp.Receipts[0])
	}
	if shortResp.HasOtherChanges == nil || *shortResp.HasOtherChanges || shortResp.NextCursor == nil || *shortResp.NextCursor != curVer {
		t.Fatalf("expected hasOtherChanges=false and nextCursor=%d, got %#v", curVer, shortResp)
	}

	// 3. Compact batch push with echo-skip nextCursor when no other device wrote, vs hasOtherChanges=true when another record changed.
	var batchResp struct {
		Receipts        []compactReceipt `json:"receipts"`
		NextCursor      *int64           `json:"nextCursor"`
		HasOtherChanges *bool            `json:"hasOtherChanges"`
	}
	mustJSON(t, c.request("POST", "/api/sync", map[string]any{
		"mutations": []mutation{
			{OpID: randomID(), Base: 0, Record: note("batch-note-a", "批量A", "正文A")},
			{OpID: randomID(), Base: 0, Record: note("batch-note-b", "批量B", "正文B")},
		},
		"cursor":  curVer,
		"compact": true,
	}), 200, &batchResp)
	if len(batchResp.Receipts) != 2 || batchResp.Receipts[0].Record != nil || batchResp.Receipts[1].Record != nil {
		t.Fatalf("compact receipts should omit record body: %#v", batchResp.Receipts)
	}
	if batchResp.HasOtherChanges == nil || *batchResp.HasOtherChanges || batchResp.NextCursor == nil || *batchResp.NextCursor <= curVer {
		t.Fatalf("expected echo-skip nextCursor > %d, got %#v", curVer, batchResp)
	}
	staleCursor := curVer
	// Now simulate another device writing note C, then this device pushes note D with staleCursor -> must signal hasOtherChanges=true.
	c.push(note("remote-note-c", "另一端C", "正文C"), 0)
	var otherResp struct {
		Receipts        []compactReceipt `json:"receipts"`
		NextCursor      *int64           `json:"nextCursor"`
		HasOtherChanges *bool            `json:"hasOtherChanges"`
	}
	mustJSON(t, c.request("POST", "/api/sync", map[string]any{
		"mutations": []mutation{{OpID: randomID(), Base: 0, Record: note("local-note-d", "本端D", "正文D")}},
		"cursor":    staleCursor,
		"compact":   true,
	}), 200, &otherResp)
	if otherResp.HasOtherChanges == nil || !*otherResp.HasOtherChanges || otherResp.NextCursor != nil {
		t.Fatalf("expected hasOtherChanges=true when remote changes exist, got %#v", otherResp)
	}

	// 4. Attachment SHA-256 instant dedup check.
	fileContent := "duplicate-image-bytes-for-instant-dedup"
	hash := hashToken(fileContent)
	var checkMiss struct {
		Exists bool `json:"exists"`
	}
	mustJSON(t, c.request("POST", "/api/attachments/check", map[string]any{
		"id": "attach-instant-1", "noteId": "batch-note-a", "hash": hash, "filename": "a.txt",
	}), 200, &checkMiss)
	if checkMiss.Exists {
		t.Fatal("expected exists=false before first upload")
	}
	mustJSON(t, c.upload("attach-instant-1", "batch-note-a", "a.txt", fileContent), 200, nil)

	var checkHit struct {
		Exists bool   `json:"exists"`
		Hash   string `json:"hash"`
	}
	mustJSON(t, c.request("POST", "/api/attachments/check", map[string]any{
		"id": "attach-instant-2", "noteId": "batch-note-b", "hash": hash, "filename": "b.txt",
	}), 200, &checkHit)
	if !checkHit.Exists || checkHit.Hash != hash {
		t.Fatalf("expected instant dedup hit with hash %s, got %#v", hash, checkHit)
	}
	dl := c.request("GET", "/api/attachments/attach-instant-2", nil)
	if dl.Code != 200 || dl.Body.String() != fileContent {
		t.Fatalf("instant-dedup attachment not downloadable: %d %q", dl.Code, dl.Body.String())
	}
}

func TestFirstRunWebSetupAndEmbeddedUI(t *testing.T) {
	a, e := openApp(t.TempDir(), "", "https://notes.example.test")
	if e != nil {
		t.Fatal(e)
	}
	defer a.db.Close()
	if e = a.bootstrap("", ""); e != nil {
		t.Fatalf("empty bootstrap should allow web setup, got: %v", e)
	}
	h := a.routes()
	req := func(method, path string, body any) *httptest.ResponseRecorder {
		var rBody io.Reader
		if body != nil {
			raw, _ := json.Marshal(body)
			rBody = bytes.NewReader(raw)
		}
		r := httptest.NewRequest(method, path, rBody)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "http://tauri.localhost")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}

	// 1. Embedded web UI serves index.html & allows Tauri CORS preflight.
	webRes := req("GET", "/", nil)
	if webRes.Code != 200 || !strings.Contains(webRes.Body.String(), "<title>") {
		t.Fatalf("embedded web fallback failed: %d", webRes.Code)
	}
	if got := webRes.Header().Get("Access-Control-Allow-Origin"); got != "http://tauri.localhost" {
		t.Fatalf("expected Tauri CORS allow-origin, got %q", got)
	}

	// 2. Fresh DB reports needsSetup = true.
	var status struct {
		NeedsSetup bool `json:"needsSetup"`
	}
	mustJSON(t, req("GET", "/api/setup", nil), 200, &status)
	if !status.NeedsSetup {
		t.Fatal("expected needsSetup=true before initialization")
	}

	// 3. Reject weak password < 12 chars.
	mustJSON(t, req("POST", "/api/setup", map[string]string{
		"username": "admin",
		"password": "short",
		"device":   "桌面端",
	}), 400, nil)

	// 4. Create first admin & return bearer session.
	var setupRes struct {
		Token string `json:"token"`
		User  user   `json:"user"`
	}
	mustJSON(t, req("POST", "/api/setup", map[string]string{
		"username": "admin",
		"password": "correct-horse-battery",
		"device":   "Windows 桌面",
	}), 200, &setupRes)
	if setupRes.Token == "" || !setupRes.User.Admin || setupRes.User.Username != "admin" {
		t.Fatalf("unexpected setup response: %#v", setupRes)
	}

	// 5. Subsequent status reports needsSetup = false & POST /api/setup locks out with 403.
	mustJSON(t, req("GET", "/api/setup", nil), 200, &status)
	if status.NeedsSetup {
		t.Fatal("expected needsSetup=false after admin initialized")
	}
	mustJSON(t, req("POST", "/api/setup", map[string]string{
		"username": "attacker",
		"password": "correct-horse-battery",
	}), 403, nil)
}
