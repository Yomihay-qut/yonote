package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

type apiKeyInfo struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Prefix     string   `json:"prefix"`
	Scopes     []string `json:"scopes"`
	FolderIDs  []string `json:"folderIds"`
	CreatedAt  string   `json:"createdAt"`
	LastUsedAt string   `json:"lastUsedAt"`
}

type agentPrincipal struct {
	User      user
	KeyID     string
	Scopes    map[string]bool
	FolderIDs []string
	FolderSet map[string]bool
}

func (p agentPrincipal) hasScope(scope string) bool {
	return p.Scopes[scope]
}

func (p agentPrincipal) folderAllowed(folderID string) bool {
	if len(p.FolderIDs) == 0 {
		return true
	}
	return p.FolderSet[folderID]
}

var validAgentScopes = map[string]bool{
	"read":  true,
	"write": true,
	"todo":  true,
}

var shanghaiTZ = time.FixedZone("CST", 8*3600)

// --- User-facing API Key management (requires device session token, never an API key) ---

func (a *app) listAPIKeys(w http.ResponseWriter, r *http.Request, u user) error {
	rows, e := a.db.Query(
		"SELECT id,name,prefix,scopes,folder_ids,created_at,COALESCE(last_used_at,'') FROM api_keys WHERE user_id=? ORDER BY created_at DESC",
		u.ID,
	)
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []apiKeyInfo{}
	for rows.Next() {
		var item apiKeyInfo
		var scopesRaw, foldersRaw string
		if e = rows.Scan(&item.ID, &item.Name, &item.Prefix, &scopesRaw, &foldersRaw, &item.CreatedAt, &item.LastUsedAt); e != nil {
			return e
		}
		if len(item.Prefix) > 6 {
			item.Prefix = item.Prefix[:6]
		}
		_ = json.Unmarshal([]byte(scopesRaw), &item.Scopes)
		_ = json.Unmarshal([]byte(foldersRaw), &item.FolderIDs)
		if item.Scopes == nil {
			item.Scopes = []string{}
		}
		if item.FolderIDs == nil {
			item.FolderIDs = []string{}
		}
		out = append(out, item)
	}
	output(w, 200, out)
	return rows.Err()
}

func (a *app) createAPIKey(w http.ResponseWriter, r *http.Request, u user) error {
	var in struct {
		Name      string   `json:"name"`
		Scopes    []string `json:"scopes"`
		FolderIDs []string `json:"folderIds"`
	}
	if e := decodeLimit(w, r, &in, 4<<10); e != nil {
		return e
	}
	name := strings.TrimSpace(in.Name)
	if len(name) < 1 || len(name) > 80 {
		return bad("密钥名称需为 1–80 字符")
	}
	seenScope := map[string]bool{}
	scopes := []string{}
	for _, s := range in.Scopes {
		s = strings.TrimSpace(s)
		if !validAgentScopes[s] {
			return bad("不支持的权限项：" + s)
		}
		if !seenScope[s] {
			seenScope[s] = true
			scopes = append(scopes, s)
		}
	}
	if len(scopes) == 0 {
		return bad("请至少选择一项权限")
	}
	seenFolder := map[string]bool{}
	folderIDs := []string{}
	for _, fid := range in.FolderIDs {
		fid = strings.TrimSpace(fid)
		if len(fid) > 80 {
			return bad("文件夹 ID 无效")
		}
		if !seenFolder[fid] {
			seenFolder[fid] = true
			folderIDs = append(folderIDs, fid)
		}
	}
	var count int
	if e := a.db.QueryRow("SELECT count(*) FROM api_keys WHERE user_id=?", u.ID).Scan(&count); e != nil {
		return e
	}
	if count >= 30 {
		return bad("最多可创建 30 个接入密钥")
	}

	rawKey := "yn_" + randomToken()
	prefix := rawKey[:6]
	id := randomID()
	createdAt := now()
	scopesJSON, _ := json.Marshal(scopes)
	foldersJSON, _ := json.Marshal(folderIDs)

	if _, e := a.db.Exec(
		"INSERT INTO api_keys(id,user_id,name,prefix,key_hash,scopes,folder_ids,created_at,last_used_at) VALUES(?,?,?,?,?,?,?,?,?)",
		id, u.ID, name, prefix, hashToken(rawKey), string(scopesJSON), string(foldersJSON), createdAt, "",
	); e != nil {
		return e
	}
	output(w, 201, map[string]any{
		"key": rawKey,
		"item": apiKeyInfo{
			ID:        id,
			Name:      name,
			Prefix:    prefix,
			Scopes:    scopes,
			FolderIDs: folderIDs,
			CreatedAt: createdAt,
		},
	})
	return nil
}

func (a *app) revokeAPIKey(w http.ResponseWriter, r *http.Request, u user) error {
	if _, e := a.db.Exec("DELETE FROM api_keys WHERE user_id=? AND id=?", u.ID, r.PathValue("id")); e != nil {
		return e
	}
	output(w, 200, map[string]bool{"ok": true})
	return nil
}

// --- Scoped Agent Authentication & Rate Limiting ---

func (a *app) authenticateAgent(r *http.Request) (agentPrincipal, error) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return agentPrincipal{}, apiError{401, "缺少有效密钥"}
	}
	rawKey := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	if !strings.HasPrefix(rawKey, "yn_") || len(rawKey) < 20 || len(rawKey) > 128 {
		return agentPrincipal{}, apiError{401, "密钥无效或已吊销"}
	}
	var p agentPrincipal
	var scopesRaw, foldersRaw string
	e := a.db.QueryRow(
		`SELECT k.id,k.scopes,k.folder_ids,u.id,u.username,u.admin,u.quota,u.disabled
		 FROM api_keys k JOIN users u ON u.id=k.user_id
		 WHERE k.key_hash=?`,
		hashToken(rawKey),
	).Scan(&p.KeyID, &scopesRaw, &foldersRaw, &p.User.ID, &p.User.Username, &p.User.Admin, &p.User.Quota, &p.User.Disabled)
	if e != nil || p.User.Disabled {
		return agentPrincipal{}, apiError{401, "密钥无效或已吊销"}
	}
	var scopes []string
	_ = json.Unmarshal([]byte(scopesRaw), &scopes)
	p.Scopes = map[string]bool{}
	for _, s := range scopes {
		p.Scopes[s] = true
	}
	_ = json.Unmarshal([]byte(foldersRaw), &p.FolderIDs)
	p.FolderSet = map[string]bool{}
	for _, f := range p.FolderIDs {
		p.FolderSet[f] = true
	}
	return p, nil
}

func (a *app) checkAgentRate(keyID string) bool {
	a.agentMu.Lock()
	defer a.agentMu.Unlock()
	at := a.agentHits[keyID]
	if time.Since(at.start) > time.Minute {
		at = attempt{start: time.Now()}
	}
	at.count++
	a.agentHits[keyID] = at
	if len(a.agentHits) > 4096 {
		for k, v := range a.agentHits {
			if time.Since(v.start) > time.Minute {
				delete(a.agentHits, k)
			}
		}
	}
	return at.count <= 90
}

type agentHandler func(http.ResponseWriter, *http.Request, agentPrincipal) error

func (a *app) authAgent(requiredScope string, h agentHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, e := a.authenticateAgent(r)
		if e != nil {
			fail(w, e)
			return
		}
		if !a.checkAgentRate(p.KeyID) {
			w.Header().Set("Retry-After", "60")
			fail(w, apiError{429, "请求过于频繁，请稍后再试"})
			return
		}
		if requiredScope != "" && !p.hasScope(requiredScope) {
			fail(w, apiError{403, "当前密钥无此操作权限"})
			return
		}
		_, _ = a.db.Exec("UPDATE api_keys SET last_used_at=? WHERE id=?", now(), p.KeyID)
		if e = h(w, r, p); e != nil {
			fail(w, e)
		}
	}
}

// --- Shared Agent Service Logic (used by both /api/agent/* REST and /mcp) ---

type agentFolder struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Module string `json:"module"`
	Color  string `json:"color,omitempty"`
}

type agentNoteSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Excerpt   string `json:"excerpt"`
	FolderID  string `json:"folderId"`
	Folder    string `json:"folder"`
	Pinned    bool   `json:"pinned"`
	Starred   bool   `json:"starred"`
	UpdatedAt string `json:"updatedAt"`
	Version   int64  `json:"version"`
}

type agentNoteDetail struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Markdown  string `json:"markdown"`
	FolderID  string `json:"folderId"`
	Folder    string `json:"folder"`
	Pinned    bool   `json:"pinned"`
	Starred   bool   `json:"starred"`
	UpdatedAt string `json:"updatedAt"`
	Version   int64  `json:"version"`
}

type agentTodoItem struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Note      string `json:"note"`
	Done      bool   `json:"done"`
	DoneAt    string `json:"doneAt,omitempty"`
	FolderID  string `json:"folderId"`
	Folder    string `json:"folder"`
	Pinned    bool   `json:"pinned"`
	UpdatedAt string `json:"updatedAt"`
	Version   int64  `json:"version"`
}

func (a *app) agentFolderMap(uid string) (map[string]agentFolder, []agentFolder, error) {
	rows, e := a.db.Query("SELECT id,kind,version,updated,deleted,payload FROM records WHERE user_id=? AND kind='folder' AND deleted IS NULL", uid)
	if e != nil {
		return nil, nil, e
	}
	defer rows.Close()
	byID := map[string]agentFolder{}
	list := []agentFolder{}
	for rows.Next() {
		v, e := scanRecord(rows)
		if e != nil {
			return nil, nil, e
		}
		f := agentFolder{
			ID:     v.ID,
			Name:   stringValue(v.Value, "name"),
			Module: stringValue(v.Value, "module"),
			Color:  stringValue(v.Value, "color"),
		}
		byID[f.ID] = f
		list = append(list, f)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Module != list[j].Module {
			return list[i].Module < list[j].Module
		}
		return list[i].Name < list[j].Name
	})
	return byID, list, rows.Err()
}

func (a *app) agentResolveFolder(p agentPrincipal, module, folderID, folderName string) (string, error) {
	byID, list, e := a.agentFolderMap(p.User.ID)
	if e != nil {
		return "", e
	}
	if folderID != "" {
		f, ok := byID[folderID]
		if !ok || f.Module != module {
			return "", bad("指定的文件夹不存在")
		}
		if !p.folderAllowed(folderID) {
			return "", apiError{403, "当前密钥无权访问该文件夹"}
		}
		return folderID, nil
	}
	name := strings.TrimSpace(folderName)
	if name == "" || name == "默认" {
		if name == "默认" {
			if !p.folderAllowed("") {
				return "", apiError{403, "当前密钥无权访问默认文件夹"}
			}
			return "", nil
		}
		if len(p.FolderIDs) > 0 {
			for _, allowed := range p.FolderIDs {
				if allowed == "" {
					return "", nil
				}
				if f, ok := byID[allowed]; ok && f.Module == module {
					return allowed, nil
				}
			}
			return "", apiError{403, "当前密钥未授权该模块的任何文件夹"}
		}
		return "", nil
	}
	for _, f := range list {
		if f.Module == module && strings.EqualFold(strings.TrimSpace(f.Name), name) {
			if !p.folderAllowed(f.ID) {
				return "", apiError{403, "当前密钥无权访问该文件夹"}
			}
			return f.ID, nil
		}
	}
	return "", bad("找不到名为「" + name + "」的文件夹")
}

func folderDisplayName(byID map[string]agentFolder, id string) string {
	if id == "" {
		return "默认"
	}
	if f, ok := byID[id]; ok && f.Name != "" {
		return f.Name
	}
	return "默认"
}

func (a *app) agentListFolders(p agentPrincipal) ([]agentFolder, error) {
	_, list, e := a.agentFolderMap(p.User.ID)
	if e != nil {
		return nil, e
	}
	out := []agentFolder{}
	if p.folderAllowed("") {
		out = append(out, agentFolder{ID: "", Name: "默认", Module: "note"})
		out = append(out, agentFolder{ID: "", Name: "默认", Module: "todo"})
	}
	for _, f := range list {
		if p.folderAllowed(f.ID) {
			out = append(out, f)
		}
	}
	return out, nil
}

func (a *app) agentListNotes(p agentPrincipal, query, folderFilter string, limit int) ([]agentNoteSummary, error) {
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	byID, _, e := a.agentFolderMap(p.User.ID)
	if e != nil {
		return nil, e
	}
	targetFolder := ""
	hasFolderFilter := false
	if strings.TrimSpace(folderFilter) != "" {
		hasFolderFilter = true
		if _, ok := byID[folderFilter]; ok {
			targetFolder = folderFilter
		} else {
			resolved, err := a.agentResolveFolder(p, "note", "", folderFilter)
			if err != nil {
				return nil, err
			}
			targetFolder = resolved
		}
		if !p.folderAllowed(targetFolder) {
			return nil, apiError{403, "当前密钥无权访问该文件夹"}
		}
	}

	rows, e := a.db.Query(
		"SELECT id,kind,version,updated,deleted,payload FROM records WHERE user_id=? AND kind='note' AND deleted IS NULL AND COALESCE(json_extract(payload,'$.purged'),0)=0 ORDER BY updated DESC",
		p.User.ID,
	)
	if e != nil {
		return nil, e
	}
	defer rows.Close()

	q := strings.ToLower(strings.TrimSpace(query))
	out := []agentNoteSummary{}
	for rows.Next() {
		v, e := scanRecord(rows)
		if e != nil {
			return nil, e
		}
		fid := stringValue(v.Value, "folderId")
		if !p.folderAllowed(fid) {
			continue
		}
		if hasFolderFilter && fid != targetFolder {
			continue
		}
		title := stringValue(v.Value, "title")
		plain := stringValue(v.Value, "plainText")
		if plain == "" {
			plain = docPlainText(v.Value["content"])
		}
		if q != "" {
			if !strings.Contains(strings.ToLower(title), q) && !strings.Contains(strings.ToLower(plain), q) {
				continue
			}
		}
		excerpt := strings.TrimSpace(plain)
		if rs := []rune(excerpt); len(rs) > 160 {
			excerpt = string(rs[:160]) + "…"
		}
		out = append(out, agentNoteSummary{
			ID:        v.ID,
			Title:     title,
			Excerpt:   excerpt,
			FolderID:  fid,
			Folder:    folderDisplayName(byID, fid),
			Pinned:    boolValue(v.Value, "pinned"),
			Starred:   boolValue(v.Value, "starred"),
			UpdatedAt: v.UpdatedAt,
			Version:   v.Version,
		})
		if len(out) >= limit {
			break
		}
	}
	return out, rows.Err()
}

func (a *app) agentReadNote(p agentPrincipal, id string) (agentNoteDetail, error) {
	byID, _, e := a.agentFolderMap(p.User.ID)
	if e != nil {
		return agentNoteDetail{}, e
	}
	v, e := scanRecord(a.db.QueryRow(
		"SELECT id,kind,version,updated,deleted,payload FROM records WHERE user_id=? AND id=? AND kind='note' AND deleted IS NULL",
		p.User.ID, id,
	))
	if e != nil {
		return agentNoteDetail{}, apiError{404, "备忘不存在"}
	}
	fid := stringValue(v.Value, "folderId")
	if !p.folderAllowed(fid) {
		return agentNoteDetail{}, apiError{403, "当前密钥无权访问该文件夹中的备忘"}
	}
	md := docToMarkdown(v.Value["content"])
	if md == "" {
		md = stringValue(v.Value, "plainText")
	}
	return agentNoteDetail{
		ID:        v.ID,
		Title:     stringValue(v.Value, "title"),
		Markdown:  md,
		FolderID:  fid,
		Folder:    folderDisplayName(byID, fid),
		Pinned:    boolValue(v.Value, "pinned"),
		Starred:   boolValue(v.Value, "starred"),
		UpdatedAt: v.UpdatedAt,
		Version:   v.Version,
	}, nil
}

func (a *app) recordNoteHistory(tx *sql.Tx, uid string, v record) error {
	var hid, created string
	he := tx.QueryRow("SELECT id,created FROM history WHERE user_id=? AND note_id=? ORDER BY created DESC LIMIT 1", uid, v.ID).Scan(&hid, &created)
	raw, _ := json.Marshal(v)
	stamp := now()
	ct, _ := time.Parse(time.RFC3339Nano, created)
	var count int
	_ = tx.QueryRow("SELECT count(*) FROM history WHERE user_id=? AND note_id=?", uid, v.ID).Scan(&count)
	var e error
	if he == nil && time.Since(ct) < 5*time.Minute && count > 1 {
		_, e = tx.Exec("UPDATE history SET record=? WHERE id=?", string(raw), hid)
	} else {
		_, e = tx.Exec("INSERT INTO history(id,user_id,note_id,created,record) VALUES(?,?,?,?,?)", randomID(), uid, v.ID, stamp, string(raw))
	}
	if e != nil {
		return e
	}
	_, e = tx.Exec("DELETE FROM history WHERE user_id=? AND note_id=? AND id NOT IN (SELECT id FROM history WHERE user_id=? AND note_id=? ORDER BY created DESC LIMIT 50)", uid, v.ID, uid, v.ID)
	return e
}

func (a *app) agentCreateNote(p agentPrincipal, title, md, folderID, folderName string, pinned, starred bool) (agentNoteDetail, error) {
	title = strings.TrimSpace(title)
	if len([]rune(title)) > 500 {
		return agentNoteDetail{}, bad("标题最多 500 字")
	}
	fid, e := a.agentResolveFolder(p, "note", folderID, folderName)
	if e != nil {
		return agentNoteDetail{}, e
	}
	doc := markdownToDoc(md)
	plain := docPlainText(doc)
	stamp := now()
	v := record{
		ID:   randomID(),
		Kind: "note",
		Value: map[string]any{
			"title":     title,
			"content":   doc,
			"plainText": plain,
			"folderId":  fid,
			"pinned":    pinned,
			"starred":   starred,
			"sort":      time.Now().UnixMilli(),
			"createdAt": stamp,
		},
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return agentNoteDetail{}, e
	}
	defer tx.Rollback()
	if e = validRecord(tx, p.User.ID, v); e != nil {
		return agentNoteDetail{}, e
	}
	v, e = writeRecord(tx, p.User.ID, v)
	if e != nil {
		return agentNoteDetail{}, e
	}
	if e = a.recordNoteHistory(tx, p.User.ID, v); e != nil {
		return agentNoteDetail{}, e
	}
	if e = tx.Commit(); e != nil {
		return agentNoteDetail{}, e
	}
	byID, _, _ := a.agentFolderMap(p.User.ID)
	return agentNoteDetail{
		ID:        v.ID,
		Title:     title,
		Markdown:  docToMarkdown(doc),
		FolderID:  fid,
		Folder:    folderDisplayName(byID, fid),
		Pinned:    pinned,
		Starred:   starred,
		UpdatedAt: v.UpdatedAt,
		Version:   v.Version,
	}, nil
}

type notePatch struct {
	Title    *string `json:"title"`
	Markdown *string `json:"markdown"`
	FolderID *string `json:"folderId"`
	Folder   *string `json:"folder"`
	Pinned   *bool   `json:"pinned"`
	Starred  *bool   `json:"starred"`
}

func (a *app) agentUpdateNote(p agentPrincipal, id string, patch notePatch) (agentNoteDetail, error) {
	var resolvedFolder *string
	if patch.FolderID != nil || patch.Folder != nil {
		fidIn, nameIn := "", ""
		if patch.FolderID != nil {
			fidIn = *patch.FolderID
		}
		if patch.Folder != nil {
			nameIn = *patch.Folder
		}
		fid, e := a.agentResolveFolder(p, "note", fidIn, nameIn)
		if e != nil {
			return agentNoteDetail{}, e
		}
		resolvedFolder = &fid
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return agentNoteDetail{}, e
	}
	defer tx.Rollback()
	v, e := getRecord(tx, p.User.ID, id)
	if e != nil || v.Kind != "note" || v.DeletedAt != nil || boolValue(v.Value, "purged") {
		return agentNoteDetail{}, apiError{404, "备忘不存在"}
	}
	if !p.folderAllowed(stringValue(v.Value, "folderId")) {
		return agentNoteDetail{}, apiError{403, "当前密钥无权修改该文件夹中的备忘"}
	}
	if patch.Title != nil {
		t := strings.TrimSpace(*patch.Title)
		if len([]rune(t)) > 500 {
			return agentNoteDetail{}, bad("标题最多 500 字")
		}
		v.Value["title"] = t
	}
	if patch.Markdown != nil {
		doc := markdownToDoc(*patch.Markdown)
		v.Value["content"] = doc
		v.Value["plainText"] = docPlainText(doc)
	}
	if resolvedFolder != nil {
		v.Value["folderId"] = *resolvedFolder
	}
	if patch.Pinned != nil {
		v.Value["pinned"] = *patch.Pinned
	}
	if patch.Starred != nil {
		v.Value["starred"] = *patch.Starred
	}
	if e = validRecord(tx, p.User.ID, v); e != nil {
		return agentNoteDetail{}, e
	}
	v, e = writeRecord(tx, p.User.ID, v)
	if e != nil {
		return agentNoteDetail{}, e
	}
	if e = a.recordNoteHistory(tx, p.User.ID, v); e != nil {
		return agentNoteDetail{}, e
	}
	if e = tx.Commit(); e != nil {
		return agentNoteDetail{}, e
	}
	byID, _, _ := a.agentFolderMap(p.User.ID)
	fid := stringValue(v.Value, "folderId")
	return agentNoteDetail{
		ID:        v.ID,
		Title:     stringValue(v.Value, "title"),
		Markdown:  docToMarkdown(v.Value["content"]),
		FolderID:  fid,
		Folder:    folderDisplayName(byID, fid),
		Pinned:    boolValue(v.Value, "pinned"),
		Starred:   boolValue(v.Value, "starred"),
		UpdatedAt: v.UpdatedAt,
		Version:   v.Version,
	}, nil
}

func (a *app) agentAppendNote(p agentPrincipal, id, md string, addTimestamp bool) (agentNoteDetail, error) {
	md = strings.TrimSpace(md)
	if md == "" {
		return agentNoteDetail{}, bad("追加内容不能为空")
	}
	if addTimestamp {
		md = "**" + time.Now().In(shanghaiTZ).Format("15:04") + "**\n" + md
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return agentNoteDetail{}, e
	}
	defer tx.Rollback()
	v, e := getRecord(tx, p.User.ID, id)
	if e != nil || v.Kind != "note" || v.DeletedAt != nil || boolValue(v.Value, "purged") {
		return agentNoteDetail{}, apiError{404, "备忘不存在"}
	}
	if !p.folderAllowed(stringValue(v.Value, "folderId")) {
		return agentNoteDetail{}, apiError{403, "当前密钥无权修改该文件夹中的备忘"}
	}
	merged := appendMarkdownToDoc(v.Value["content"], md)
	v.Value["content"] = merged
	v.Value["plainText"] = docPlainText(merged)
	v, e = writeRecord(tx, p.User.ID, v)
	if e != nil {
		return agentNoteDetail{}, e
	}
	if e = a.recordNoteHistory(tx, p.User.ID, v); e != nil {
		return agentNoteDetail{}, e
	}
	if e = tx.Commit(); e != nil {
		return agentNoteDetail{}, e
	}
	byID, _, _ := a.agentFolderMap(p.User.ID)
	fid := stringValue(v.Value, "folderId")
	return agentNoteDetail{
		ID:        v.ID,
		Title:     stringValue(v.Value, "title"),
		Markdown:  docToMarkdown(v.Value["content"]),
		FolderID:  fid,
		Folder:    folderDisplayName(byID, fid),
		Pinned:    boolValue(v.Value, "pinned"),
		Starred:   boolValue(v.Value, "starred"),
		UpdatedAt: v.UpdatedAt,
		Version:   v.Version,
	}, nil
}

func (a *app) agentAppendDiary(p agentPrincipal, md, dateStr, folderName string, addTimestamp bool) (agentNoteDetail, error) {
	md = strings.TrimSpace(md)
	if md == "" {
		return agentNoteDetail{}, bad("日记内容不能为空")
	}
	if strings.TrimSpace(dateStr) == "" {
		dateStr = time.Now().In(shanghaiTZ).Format("2006-01-02")
	}
	if len([]rune(dateStr)) > 40 {
		return agentNoteDetail{}, bad("日期标题过长")
	}
	// Resolve target folder: explicit folderName > existing "日记" folder (if allowed) > default/first allowed folder.
	fid := ""
	if strings.TrimSpace(folderName) != "" {
		var err error
		fid, err = a.agentResolveFolder(p, "note", "", folderName)
		if err != nil {
			return agentNoteDetail{}, err
		}
	} else {
		_, list, _ := a.agentFolderMap(p.User.ID)
		foundDiary := false
		for _, f := range list {
			if f.Module == "note" && (f.Name == "日记" || strings.EqualFold(f.Name, "diary")) && p.folderAllowed(f.ID) {
				fid = f.ID
				foundDiary = true
				break
			}
		}
		if !foundDiary {
			var err error
			fid, err = a.agentResolveFolder(p, "note", "", "")
			if err != nil {
				return agentNoteDetail{}, err
			}
		}
	}

	// Look for an existing note with title == dateStr in allowed folders (preferring fid).
	var existingID string
	rows, e := a.db.Query(
		"SELECT id,kind,version,updated,deleted,payload FROM records WHERE user_id=? AND kind='note' AND deleted IS NULL AND json_extract(payload,'$.title')=? ORDER BY updated DESC",
		p.User.ID, dateStr,
	)
	if e != nil {
		return agentNoteDetail{}, e
	}
	for rows.Next() {
		v, err := scanRecord(rows)
		if err != nil {
			continue
		}
		rfid := stringValue(v.Value, "folderId")
		if !p.folderAllowed(rfid) {
			continue
		}
		if existingID == "" || rfid == fid {
			existingID = v.ID
			if rfid == fid {
				break
			}
		}
	}
	rows.Close()

	if existingID != "" {
		return a.agentAppendNote(p, existingID, md, addTimestamp)
	}
	body := md
	if addTimestamp {
		body = "**" + time.Now().In(shanghaiTZ).Format("15:04") + "**\n" + md
	}
	return a.agentCreateNote(p, dateStr, body, fid, "", false, false)
}

func (a *app) agentSoftDelete(p agentPrincipal, kind, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	v, e := getRecord(tx, p.User.ID, id)
	if e != nil || v.Kind != kind || v.DeletedAt != nil || boolValue(v.Value, "purged") {
		return apiError{404, "记录不存在"}
	}
	if !p.folderAllowed(stringValue(v.Value, "folderId")) {
		return apiError{403, "当前密钥无权操作该文件夹中的记录"}
	}
	s := now()
	v.DeletedAt = &s
	if _, e = writeRecord(tx, p.User.ID, v); e != nil {
		return e
	}
	return tx.Commit()
}

func (a *app) agentListTodos(p agentPrincipal, doneFilter, query, folderFilter string, limit int) ([]agentTodoItem, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	byID, _, e := a.agentFolderMap(p.User.ID)
	if e != nil {
		return nil, e
	}
	targetFolder := ""
	hasFolderFilter := false
	if strings.TrimSpace(folderFilter) != "" {
		hasFolderFilter = true
		if _, ok := byID[folderFilter]; ok {
			targetFolder = folderFilter
		} else {
			resolved, err := a.agentResolveFolder(p, "todo", "", folderFilter)
			if err != nil {
				return nil, err
			}
			targetFolder = resolved
		}
		if !p.folderAllowed(targetFolder) {
			return nil, apiError{403, "当前密钥无权访问该文件夹"}
		}
	}

	rows, e := a.db.Query(
		"SELECT id,kind,version,updated,deleted,payload FROM records WHERE user_id=? AND kind='todo' AND deleted IS NULL AND COALESCE(json_extract(payload,'$.purged'),0)=0 ORDER BY updated DESC",
		p.User.ID,
	)
	if e != nil {
		return nil, e
	}
	defer rows.Close()

	q := strings.ToLower(strings.TrimSpace(query))
	out := []agentTodoItem{}
	for rows.Next() {
		v, e := scanRecord(rows)
		if e != nil {
			return nil, e
		}
		fid := stringValue(v.Value, "folderId")
		if !p.folderAllowed(fid) {
			continue
		}
		if hasFolderFilter && fid != targetFolder {
			continue
		}
		done := boolValue(v.Value, "done")
		if doneFilter == "true" && !done {
			continue
		}
		if doneFilter == "false" && done {
			continue
		}
		title := stringValue(v.Value, "title")
		note := stringValue(v.Value, "note")
		if q != "" && !strings.Contains(strings.ToLower(title), q) && !strings.Contains(strings.ToLower(note), q) {
			continue
		}
		out = append(out, agentTodoItem{
			ID:        v.ID,
			Title:     title,
			Note:      note,
			Done:      done,
			DoneAt:    stringValue(v.Value, "doneAt"),
			FolderID:  fid,
			Folder:    folderDisplayName(byID, fid),
			Pinned:    boolValue(v.Value, "pinned"),
			UpdatedAt: v.UpdatedAt,
			Version:   v.Version,
		})
		if len(out) >= limit {
			break
		}
	}
	return out, rows.Err()
}

func (a *app) agentCreateTodo(p agentPrincipal, title, note, folderID, folderName string, pinned bool) (agentTodoItem, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return agentTodoItem{}, bad("待办标题不能为空")
	}
	if len([]rune(title)) > 500 {
		return agentTodoItem{}, bad("标题最多 500 字")
	}
	fid, e := a.agentResolveFolder(p, "todo", folderID, folderName)
	if e != nil {
		return agentTodoItem{}, e
	}
	stamp := now()
	v := record{
		ID:   randomID(),
		Kind: "todo",
		Value: map[string]any{
			"title":     title,
			"note":      note,
			"done":      false,
			"doneAt":    nil,
			"folderId":  fid,
			"pinned":    pinned,
			"sort":      time.Now().UnixMilli(),
			"createdAt": stamp,
		},
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return agentTodoItem{}, e
	}
	defer tx.Rollback()
	if e = validRecord(tx, p.User.ID, v); e != nil {
		return agentTodoItem{}, e
	}
	v, e = writeRecord(tx, p.User.ID, v)
	if e != nil {
		return agentTodoItem{}, e
	}
	if e = tx.Commit(); e != nil {
		return agentTodoItem{}, e
	}
	byID, _, _ := a.agentFolderMap(p.User.ID)
	return agentTodoItem{
		ID:        v.ID,
		Title:     title,
		Note:      note,
		Done:      false,
		FolderID:  fid,
		Folder:    folderDisplayName(byID, fid),
		Pinned:    pinned,
		UpdatedAt: v.UpdatedAt,
		Version:   v.Version,
	}, nil
}

type todoPatch struct {
	Title    *string `json:"title"`
	Note     *string `json:"note"`
	Done     *bool   `json:"done"`
	FolderID *string `json:"folderId"`
	Folder   *string `json:"folder"`
	Pinned   *bool   `json:"pinned"`
}

func (a *app) agentUpdateTodo(p agentPrincipal, id string, patch todoPatch) (agentTodoItem, error) {
	var resolvedFolder *string
	if patch.FolderID != nil || patch.Folder != nil {
		fidIn, nameIn := "", ""
		if patch.FolderID != nil {
			fidIn = *patch.FolderID
		}
		if patch.Folder != nil {
			nameIn = *patch.Folder
		}
		fid, e := a.agentResolveFolder(p, "todo", fidIn, nameIn)
		if e != nil {
			return agentTodoItem{}, e
		}
		resolvedFolder = &fid
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return agentTodoItem{}, e
	}
	defer tx.Rollback()
	v, e := getRecord(tx, p.User.ID, id)
	if e != nil || v.Kind != "todo" || v.DeletedAt != nil || boolValue(v.Value, "purged") {
		return agentTodoItem{}, apiError{404, "待办不存在"}
	}
	if !p.folderAllowed(stringValue(v.Value, "folderId")) {
		return agentTodoItem{}, apiError{403, "当前密钥无权修改该文件夹中的待办"}
	}
	if patch.Title != nil {
		t := strings.TrimSpace(*patch.Title)
		if len([]rune(t)) > 500 {
			return agentTodoItem{}, bad("标题最多 500 字")
		}
		v.Value["title"] = t
	}
	if patch.Note != nil {
		v.Value["note"] = *patch.Note
	}
	if patch.Done != nil {
		v.Value["done"] = *patch.Done
		if *patch.Done {
			v.Value["doneAt"] = now()
		} else {
			v.Value["doneAt"] = nil
		}
	}
	if resolvedFolder != nil {
		v.Value["folderId"] = *resolvedFolder
	}
	if patch.Pinned != nil {
		v.Value["pinned"] = *patch.Pinned
	}
	if e = validRecord(tx, p.User.ID, v); e != nil {
		return agentTodoItem{}, e
	}
	v, e = writeRecord(tx, p.User.ID, v)
	if e != nil {
		return agentTodoItem{}, e
	}
	if e = tx.Commit(); e != nil {
		return agentTodoItem{}, e
	}
	byID, _, _ := a.agentFolderMap(p.User.ID)
	fid := stringValue(v.Value, "folderId")
	return agentTodoItem{
		ID:        v.ID,
		Title:     stringValue(v.Value, "title"),
		Note:      stringValue(v.Value, "note"),
		Done:      boolValue(v.Value, "done"),
		DoneAt:    stringValue(v.Value, "doneAt"),
		FolderID:  fid,
		Folder:    folderDisplayName(byID, fid),
		Pinned:    boolValue(v.Value, "pinned"),
		UpdatedAt: v.UpdatedAt,
		Version:   v.Version,
	}, nil
}

// --- REST HTTP Handlers for /api/agent/* ---

func (a *app) httpAgentFolders(w http.ResponseWriter, r *http.Request, p agentPrincipal) error {
	folders, e := a.agentListFolders(p)
	if e != nil {
		return e
	}
	output(w, 200, folders)
	return nil
}

func (a *app) httpAgentListNotes(w http.ResponseWriter, r *http.Request, p agentPrincipal) error {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	notes, e := a.agentListNotes(p, r.URL.Query().Get("q"), r.URL.Query().Get("folder"), limit)
	if e != nil {
		return e
	}
	output(w, 200, notes)
	return nil
}

func (a *app) httpAgentReadNote(w http.ResponseWriter, r *http.Request, p agentPrincipal) error {
	note, e := a.agentReadNote(p, r.PathValue("id"))
	if e != nil {
		return e
	}
	output(w, 200, note)
	return nil
}

func (a *app) httpAgentCreateNote(w http.ResponseWriter, r *http.Request, p agentPrincipal) error {
	var in struct {
		Title    string `json:"title"`
		Markdown string `json:"markdown"`
		FolderID string `json:"folderId"`
		Folder   string `json:"folder"`
		Pinned   bool   `json:"pinned"`
		Starred  bool   `json:"starred"`
	}
	if e := decodeLimit(w, r, &in, 512<<10); e != nil {
		return e
	}
	note, e := a.agentCreateNote(p, in.Title, in.Markdown, in.FolderID, in.Folder, in.Pinned, in.Starred)
	if e != nil {
		return e
	}
	output(w, 201, note)
	return nil
}

func (a *app) httpAgentUpdateNote(w http.ResponseWriter, r *http.Request, p agentPrincipal) error {
	var patch notePatch
	if e := decodeLimit(w, r, &patch, 512<<10); e != nil {
		return e
	}
	note, e := a.agentUpdateNote(p, r.PathValue("id"), patch)
	if e != nil {
		return e
	}
	output(w, 200, note)
	return nil
}

func (a *app) httpAgentAppendNote(w http.ResponseWriter, r *http.Request, p agentPrincipal) error {
	var in struct {
		Markdown  string `json:"markdown"`
		Timestamp bool   `json:"timestamp"`
	}
	if e := decodeLimit(w, r, &in, 512<<10); e != nil {
		return e
	}
	note, e := a.agentAppendNote(p, r.PathValue("id"), in.Markdown, in.Timestamp)
	if e != nil {
		return e
	}
	output(w, 200, note)
	return nil
}

func (a *app) httpAgentAppendDiary(w http.ResponseWriter, r *http.Request, p agentPrincipal) error {
	var in struct {
		Markdown  string `json:"markdown"`
		Date      string `json:"date"`
		Folder    string `json:"folder"`
		Timestamp *bool  `json:"timestamp"`
	}
	if e := decodeLimit(w, r, &in, 512<<10); e != nil {
		return e
	}
	addTS := true
	if in.Timestamp != nil {
		addTS = *in.Timestamp
	}
	note, e := a.agentAppendDiary(p, in.Markdown, in.Date, in.Folder, addTS)
	if e != nil {
		return e
	}
	output(w, 200, note)
	return nil
}

func (a *app) httpAgentTrashNote(w http.ResponseWriter, r *http.Request, p agentPrincipal) error {
	if e := a.agentSoftDelete(p, "note", r.PathValue("id")); e != nil {
		return e
	}
	output(w, 200, map[string]bool{"ok": true, "trashed": true})
	return nil
}

func (a *app) httpAgentListTodos(w http.ResponseWriter, r *http.Request, p agentPrincipal) error {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	todos, e := a.agentListTodos(p, r.URL.Query().Get("done"), r.URL.Query().Get("q"), r.URL.Query().Get("folder"), limit)
	if e != nil {
		return e
	}
	output(w, 200, todos)
	return nil
}

func (a *app) httpAgentCreateTodo(w http.ResponseWriter, r *http.Request, p agentPrincipal) error {
	var in struct {
		Title    string `json:"title"`
		Note     string `json:"note"`
		FolderID string `json:"folderId"`
		Folder   string `json:"folder"`
		Pinned   bool   `json:"pinned"`
	}
	if e := decodeLimit(w, r, &in, 128<<10); e != nil {
		return e
	}
	todo, e := a.agentCreateTodo(p, in.Title, in.Note, in.FolderID, in.Folder, in.Pinned)
	if e != nil {
		return e
	}
	output(w, 201, todo)
	return nil
}

func (a *app) httpAgentUpdateTodo(w http.ResponseWriter, r *http.Request, p agentPrincipal) error {
	var patch todoPatch
	if e := decodeLimit(w, r, &patch, 128<<10); e != nil {
		return e
	}
	todo, e := a.agentUpdateTodo(p, r.PathValue("id"), patch)
	if e != nil {
		return e
	}
	output(w, 200, todo)
	return nil
}

func (a *app) httpAgentTrashTodo(w http.ResponseWriter, r *http.Request, p agentPrincipal) error {
	if e := a.agentSoftDelete(p, "todo", r.PathValue("id")); e != nil {
		return e
	}
	output(w, 200, map[string]bool{"ok": true, "trashed": true})
	return nil
}
