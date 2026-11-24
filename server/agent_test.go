package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func (c *testClient) agentRequest(key, method, path string, body any) *httptest.ResponseRecorder {
	c.t.Helper()
	var b *bytes.Reader
	if body != nil {
		raw, e := json.Marshal(body)
		if e != nil {
			c.t.Fatal(e)
		}
		b = bytes.NewReader(raw)
	} else {
		b = bytes.NewReader(nil)
	}
	r := httptest.NewRequest(method, path, b)
	r.Header.Set("Content-Type", "application/json")
	if key != "" {
		r.Header.Set("Authorization", "Bearer "+key)
	}
	w := httptest.NewRecorder()
	c.h.ServeHTTP(w, r)
	return w
}

func TestMarkdownRoundTripAndAppendPreservesImages(t *testing.T) {
	md := "# 今日计划\n\n- [ ] 写文档\n- [x] **发布** `v0.7.0`\n\n> 保持简洁\n\n```go\nfmt.Println(\"ok\")\n```"
	doc := markdownToDoc(md)
	out := docToMarkdown(doc)
	for _, want := range []string{"# 今日计划", "- [ ] 写文档", "- [x] **发布** `v0.7.0`", "> 保持简洁", "```go", `fmt.Println("ok")`} {
		if !strings.Contains(out, want) {
			t.Fatalf("round-trip missing %q in:\n%s", want, out)
		}
	}
	// Existing image node must survive appendMarkdownToDoc
	content := doc["content"].([]any)
	content = append(content, map[string]any{"type": "image", "attrs": map[string]any{"src": "attachment://img1"}})
	doc["content"] = content
	merged := appendMarkdownToDoc(doc, "## 补充\n\n晚间复盘")
	raw, _ := json.Marshal(merged)
	if !strings.Contains(string(raw), "attachment://img1") || !strings.Contains(string(raw), "晚间复盘") {
		t.Fatalf("append lost image or new text: %s", string(raw))
	}
}

func TestAPIKeyLifecycleAndPrivilegeSeparation(t *testing.T) {
	c := newTestClient(t)
	var created struct {
		Key  string `json:"key"`
		Item struct {
			ID string `json:"id"`
		} `json:"item"`
	}
	mustJSON(t, c.request("POST", "/api/keys", map[string]any{
		"name":   "Codex",
		"scopes": []string{"read", "write", "todo"},
	}), 201, &created)
	if !strings.HasPrefix(created.Key, "yn_") || created.Item.ID == "" {
		t.Fatalf("expected yn_ prefix and item.id, got %q %q", created.Key, created.Item.ID)
	}

	// List keys returns metadata without secret
	listW := c.request("GET", "/api/keys", nil)
	if listW.Code != 200 || strings.Contains(listW.Body.String(), created.Key) {
		t.Fatalf("list keys leaked secret or failed: %d %s", listW.Code, listW.Body.String())
	}

	// API key must NOT work on user/admin/device/key/sync/purge endpoints
	for _, tc := range []struct{ m, p string }{
		{"GET", "/api/me"},
		{"GET", "/api/admin/users"},
		{"GET", "/api/devices"},
		{"GET", "/api/keys"},
		{"POST", "/api/sync"},
		{"DELETE", "/api/records/note1"},
	} {
		w := c.agentRequest(created.Key, tc.m, tc.p, nil)
		if w.Code != 401 {
			t.Fatalf("API key allowed on %s %s: HTTP %d", tc.m, tc.p, w.Code)
		}
	}

	// Device token must NOT work on /api/agent/* or /mcp
	if w := c.request("GET", "/api/agent/notes", nil); w.Code != 401 {
		t.Fatalf("device token allowed on /api/agent/notes: %d", w.Code)
	}
	if w := c.request("POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"}); w.Code != 401 {
		t.Fatalf("device token allowed on /mcp: %d", w.Code)
	}

	// API key works on /api/agent/notes, then stops immediately after revocation
	if w := c.agentRequest(created.Key, "GET", "/api/agent/notes", nil); w.Code != 200 {
		t.Fatalf("agent list notes failed: %d %s", w.Code, w.Body.String())
	}
	mustJSON(t, c.request("DELETE", "/api/keys/"+created.Item.ID, nil), 200, nil)
	if w := c.agentRequest(created.Key, "GET", "/api/agent/notes", nil); w.Code != 401 {
		t.Fatalf("revoked key still accepted: %d", w.Code)
	}
}

func TestAgentScopesFolderIsolationAndSoftDelete(t *testing.T) {
	c := newTestClient(t)
	// Seed two folders and two notes via normal sync
	c.push(record{ID: "folder-work", Kind: "folder", Value: map[string]any{"name": "工作", "module": "note"}}, 0)
	c.push(record{ID: "folder-priv", Kind: "folder", Value: map[string]any{"name": "私密", "module": "note"}}, 0)
	c.push(record{ID: "note-work-1", Kind: "note", Value: map[string]any{"title": "周报", "folderId": "folder-work", "plainText": "工作内容", "content": markdownToDoc("工作内容")}}, 0)
	c.push(record{ID: "note-priv-1", Kind: "note", Value: map[string]any{"title": "密码本", "folderId": "folder-priv", "plainText": "绝密", "content": markdownToDoc("绝密")}}, 0)

	// 1. Read-only key
	var ro struct{ Key string }
	mustJSON(t, c.request("POST", "/api/keys", map[string]any{"name": "RO", "scopes": []string{"read"}}), 201, &ro)
	if w := c.agentRequest(ro.Key, "POST", "/api/agent/notes", map[string]any{"title": "x", "markdown": "y"}); w.Code != 403 {
		t.Fatalf("read-only key created note: %d", w.Code)
	}
	if w := c.agentRequest(ro.Key, "POST", "/api/agent/todos", map[string]any{"title": "x"}); w.Code != 403 {
		t.Fatalf("read-only key created todo: %d", w.Code)
	}

	// 2. Folder-restricted key (only folder-work)
	var scoped struct{ Key string }
	mustJSON(t, c.request("POST", "/api/keys", map[string]any{
		"name":      "WorkOnly",
		"scopes":    []string{"read", "write"},
		"folderIds": []string{"folder-work"},
	}), 201, &scoped)

	listW := c.agentRequest(scoped.Key, "GET", "/api/agent/notes", nil)
	if listW.Code != 200 || !strings.Contains(listW.Body.String(), "note-work-1") || strings.Contains(listW.Body.String(), "note-priv-1") {
		t.Fatalf("folder isolation failed in list: %s", listW.Body.String())
	}
	if w := c.agentRequest(scoped.Key, "GET", "/api/agent/notes/note-priv-1", nil); w.Code != 403 {
		t.Fatalf("folder-scoped key read private note: %d", w.Code)
	}
	if w := c.agentRequest(scoped.Key, "POST", "/api/agent/notes", map[string]any{"title": "bad", "folderId": "folder-priv", "markdown": "x"}); w.Code != 403 {
		t.Fatalf("folder-scoped key wrote to private folder: %d", w.Code)
	}

	// 3. Soft-delete only (note moves to trash, not purged)
	mustJSON(t, c.agentRequest(scoped.Key, "DELETE", "/api/agent/notes/note-work-1", nil), 200, nil)
	var deletedAt *string
	var payload string
	if e := c.a.db.QueryRow("SELECT deleted, payload FROM records WHERE user_id=? AND id='note-work-1'", c.uid).Scan(&deletedAt, &payload); e != nil {
		t.Fatal(e)
	}
	if deletedAt == nil || *deletedAt == "" || strings.Contains(payload, `"purged":true`) {
		t.Fatalf("expected soft delete only, got deleted=%v payload=%s", deletedAt, payload)
	}

	// 4. Cross-user isolation
	mustJSON(t, c.request("POST", "/api/admin/users", map[string]any{"username": "bob", "password": "bob-secret-password"}), 201, nil)
	var bobLogin struct{ Token string }
	mustJSON(t, c.request("POST", "/api/login", map[string]any{"username": "bob", "password": "bob-secret-password"}), 200, &bobLogin)
	bobClient := &testClient{t: t, a: c.a, h: c.h, token: bobLogin.Token}
	var bobKey struct{ Key string }
	mustJSON(t, bobClient.request("POST", "/api/keys", map[string]any{"name": "Bob", "scopes": []string{"read", "write"}}), 201, &bobKey)
	if w := bobClient.agentRequest(bobKey.Key, "GET", "/api/agent/notes/note-priv-1", nil); w.Code != 404 {
		t.Fatalf("bob accessed admin note: %d", w.Code)
	}
}

func TestAgentDiaryAndTodos(t *testing.T) {
	c := newTestClient(t)
	var k struct{ Key string }
	mustJSON(t, c.request("POST", "/api/keys", map[string]any{"name": "All", "scopes": []string{"read", "write", "todo"}}), 201, &k)

	var d1, d2 struct {
		ID       string `json:"id"`
		Markdown string `json:"markdown"`
	}
	mustJSON(t, c.agentRequest(k.Key, "POST", "/api/agent/diary/append", map[string]any{"date": "2026-11-20", "markdown": "上午完成了接口设计"}), 200, &d1)
	mustJSON(t, c.agentRequest(k.Key, "POST", "/api/agent/diary/append", map[string]any{"date": "2026-11-20", "markdown": "晚上测试全部通过"}), 200, &d2)
	if d1.ID != d2.ID || !strings.Contains(d2.Markdown, "上午完成了接口设计") || !strings.Contains(d2.Markdown, "晚上测试全部通过") {
		t.Fatalf("diary append mismatch: id1=%s id2=%s md=%q", d1.ID, d2.ID, d2.Markdown)
	}

	var todo struct {
		ID   string `json:"id"`
		Done bool   `json:"done"`
	}
	mustJSON(t, c.agentRequest(k.Key, "POST", "/api/agent/todos", map[string]any{"title": "部署 v0.7.0", "remindAt": "2026-11-20T10:00:00Z"}), 201, &todo)
	done := true
	mustJSON(t, c.agentRequest(k.Key, "PATCH", "/api/agent/todos/"+todo.ID, map[string]any{"done": &done}), 200, &todo)
	if !todo.Done {
		t.Fatal("todo not marked done")
	}
	mustJSON(t, c.agentRequest(k.Key, "DELETE", "/api/agent/todos/"+todo.ID, nil), 200, nil)
}

func TestMCPStreamableHTTP(t *testing.T) {
	c := newTestClient(t)
	var full, ro struct{ Key string }
	mustJSON(t, c.request("POST", "/api/keys", map[string]any{"name": "Full", "scopes": []string{"read", "write", "todo"}}), 201, &full)
	mustJSON(t, c.request("POST", "/api/keys", map[string]any{"name": "RO", "scopes": []string{"read"}}), 201, &ro)

	if w := c.agentRequest(full.Key, "GET", "/mcp", nil); w.Code != 405 {
		t.Fatalf("GET /mcp expected 405, got %d", w.Code)
	}
	if w := c.agentRequest(full.Key, "DELETE", "/mcp", nil); w.Code != 204 {
		t.Fatalf("DELETE /mcp expected 204, got %d", w.Code)
	}

	// initialize
	var initResp struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
		} `json:"result"`
	}
	mustJSON(t, c.agentRequest(full.Key, "POST", "/mcp", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{"protocolVersion": "2025-03-26"},
	}), 200, &initResp)
	if initResp.Result.ProtocolVersion != "2025-03-26" {
		t.Fatalf("unexpected protocolVersion: %q", initResp.Result.ProtocolVersion)
	}

	// notification
	if w := c.agentRequest(full.Key, "POST", "/mcp", map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); w.Code != 202 {
		t.Fatalf("notification expected 202, got %d", w.Code)
	}

	// tools/list filters by scopes
	var fullTools, roTools struct {
		Result struct {
			Tools []struct{ Name string } `json:"tools"`
		} `json:"result"`
	}
	mustJSON(t, c.agentRequest(full.Key, "POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}), 200, &fullTools)
	mustJSON(t, c.agentRequest(ro.Key, "POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/list"}), 200, &roTools)
	if len(fullTools.Result.Tools) != 14 || len(roTools.Result.Tools) != 5 {
		t.Fatalf("unexpected tool counts: full=%d ro=%d", len(fullTools.Result.Tools), len(roTools.Result.Tools))
	}

	// tools/call create_note
	w := c.agentRequest(full.Key, "POST", "/mcp", map[string]any{
		"jsonrpc": "2.0", "id": 4, "method": "tools/call",
		"params": map[string]any{
			"name":      "create_note",
			"arguments": map[string]any{"title": "MCP 笔记", "markdown": "来自 MCP"},
		},
	})
	if w.Code != 200 || !strings.Contains(w.Body.String(), "MCP 笔记") {
		t.Fatalf("MCP create_note failed: %d %s", w.Code, w.Body.String())
	}

	// Chunked read_note prevents MCP client truncation on long Chinese notes
	longText := strings.Repeat("这是一段用于测试长笔记分段读取的中文内容。\n", 400)
	noteDetail := agentNoteDetail{ID: "note-long-1", Title: "长笔记", Markdown: longText}
	var rebuilt strings.Builder
	offset := 0
	chunks := 0
	for {
		part := sliceNoteForMCP(noteDetail, offset, 1200)
		rebuilt.WriteString(part["markdown"].(string))
		chunks++
		if !part["hasMore"].(bool) {
			break
		}
		offset = part["nextOffset"].(int)
		if chunks > 20 {
			t.Fatal("infinite pagination loop")
		}
	}
	if chunks < 3 || rebuilt.String() != longText {
		t.Fatalf("chunked read mismatch: chunks=%d len=%d want=%d", chunks, len(rebuilt.String()), len(longText))
	}
}

func TestSecurityHardening(t *testing.T) {
	c := newTestClient(t)
	// Minimized health endpoint
	h := c.request("GET", "/api/health", nil)
	if h.Code != 200 || strings.Contains(h.Body.String(), "version") || strings.Contains(h.Body.String(), "yonote") {
		t.Fatalf("health leaked version/app: %s", h.Body.String())
	}
	// CSP drops localhost
	csp := h.Header().Get("Content-Security-Policy")
	if strings.Contains(csp, "localhost") || strings.Contains(csp, "127.0.0.1") {
		t.Fatalf("CSP still allows localhost: %s", csp)
	}
	// Login 4KB limit
	big := map[string]any{"username": strings.Repeat("a", 5000), "password": "x"}
	if w := c.request("POST", "/api/login", big); w.Code != 400 {
		t.Fatalf("oversized login expected 400, got %d", w.Code)
	}
	// Login 429 Retry-After
	for i := 0; i < 12; i++ {
		c.request("POST", "/api/login", map[string]any{"username": "nobody", "password": "wrong"})
	}
	w429 := c.request("POST", "/api/login", map[string]any{"username": "nobody", "password": "wrong"})
	if w429.Code != 429 || w429.Header().Get("Retry-After") == "" {
		t.Fatalf("expected 429 with Retry-After, got %d header=%q", w429.Code, w429.Header().Get("Retry-After"))
	}
	// PWA manifest must be served with application/manifest+json under X-Content-Type-Options: nosniff
	if err := os.WriteFile(filepath.Join(c.a.web, "manifest.webmanifest"), []byte(`{"name":"yonote"}`), 0644); err != nil {
		t.Fatal(err)
	}
	mw := c.request("GET", "/manifest.webmanifest", nil)
	if mw.Code != 200 || !strings.Contains(mw.Header().Get("Content-Type"), "application/manifest+json") {
		t.Fatalf("expected application/manifest+json for manifest.webmanifest, got %d %q", mw.Code, mw.Header().Get("Content-Type"))
	}
}
