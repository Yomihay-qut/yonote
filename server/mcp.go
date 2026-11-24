package main

import (
	"encoding/json"
	"net/http"
)

type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type mcpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type mcpResponse struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id,omitempty"`
	Result  any       `json:"result,omitempty"`
	Error   *mcpError `json:"error,omitempty"`
}

type mcpToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	scope       string
}

var yonoteMCPTools = []mcpToolDef{
	{
		Name:        "list_folders",
		Description: "列出当前密钥有权限访问的备忘与待办文件夹列表。",
		scope:       "read",
		InputSchema: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	},
	{
		Name:        "list_notes",
		Description: "按最近更新时间列出备忘摘要，可按关键词或文件夹筛选。",
		scope:       "read",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":  map[string]any{"type": "string", "description": "搜索关键词（可选）"},
				"folder": map[string]any{"type": "string", "description": "文件夹名称或 ID（可选）"},
				"limit":  map[string]any{"type": "integer", "description": "返回条数，默认 30，最大 100"},
			},
		},
	},
	{
		Name:        "search_notes",
		Description: "按关键词全文检索备忘，返回匹配的备忘 ID、标题、文件夹与摘要。",
		scope:       "read",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":  map[string]any{"type": "string", "description": "检索关键词"},
				"folder": map[string]any{"type": "string", "description": "限定文件夹名称或 ID（可选）"},
				"limit":  map[string]any{"type": "integer", "description": "返回条数，默认 20"},
			},
			"required": []string{"query"},
		},
	},
	{
		Name:        "read_note",
		Description: "按备忘 ID 读取 Markdown 正文与元信息。长笔记默认按 4500 字符分段返回以避免客户端截断；若返回 hasMore=true，请用返回的 nextOffset 作为 offset 继续读取后续分段。",
		scope:       "read",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"id":     map[string]any{"type": "string", "description": "备忘 ID"},
				"offset": map[string]any{"type": "integer", "description": "起始字符偏移（默认 0，长笔记续读时传入上一次返回的 nextOffset）"},
				"limit":  map[string]any{"type": "integer", "description": "单次最多返回的字符数（默认 4500，范围 500–20000；约 10–14KB，防止客户端截断）"},
			},
			"required": []string{"id"},
		},
	},
	{
		Name:        "create_note",
		Description: "创建一条新备忘（支持标准 Markdown：标题、列表、任务清单、代码块、引用、加粗等）。",
		scope:       "write",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"title":    map[string]any{"type": "string", "description": "备忘标题"},
				"markdown": map[string]any{"type": "string", "description": "Markdown 格式正文"},
				"folder":   map[string]any{"type": "string", "description": "目标文件夹名称（可选，默认放入默认文件夹）"},
				"pinned":   map[string]any{"type": "boolean", "description": "是否置顶（可选）"},
				"starred":  map[string]any{"type": "boolean", "description": "是否收藏（可选）"},
			},
			"required": []string{"title", "markdown"},
		},
	},
	{
		Name:        "update_note",
		Description: "修改已有备忘的标题、Markdown 正文、文件夹、置顶或收藏状态（仅更新传入字段，自动留存历史版本）。",
		scope:       "write",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"id":       map[string]any{"type": "string", "description": "备忘 ID"},
				"title":    map[string]any{"type": "string", "description": "新标题（可选）"},
				"markdown": map[string]any{"type": "string", "description": "新 Markdown 正文（可选）"},
				"folder":   map[string]any{"type": "string", "description": "目标文件夹名称（可选）"},
				"pinned":   map[string]any{"type": "boolean", "description": "是否置顶（可选）"},
				"starred":  map[string]any{"type": "boolean", "description": "是否收藏（可选）"},
			},
			"required": []string{"id"},
		},
	},
	{
		Name:        "append_to_note",
		Description: "向已有备忘末尾安全追加 Markdown 内容，不覆盖原文与已有图片/附件。",
		scope:       "write",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"id":        map[string]any{"type": "string", "description": "备忘 ID"},
				"markdown":  map[string]any{"type": "string", "description": "要追加的 Markdown 内容"},
				"timestamp": map[string]any{"type": "boolean", "description": "是否在段落前自动添加当前时间（HH:MM），默认 false"},
			},
			"required": []string{"id", "markdown"},
		},
	},
	{
		Name:        "append_daily_diary",
		Description: "追加一条今日日记。自动查找当天日期（YYYY-MM-DD）的日记并在末尾附带时间追加；若不存在则自动创建（优先放入「日记」文件夹）。",
		scope:       "write",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"markdown":  map[string]any{"type": "string", "description": "日记内容（支持 Markdown）"},
				"date":      map[string]any{"type": "string", "description": "可选日期标题，如 2026-11-20，默认今天"},
				"folder":    map[string]any{"type": "string", "description": "可选指定文件夹名"},
				"timestamp": map[string]any{"type": "boolean", "description": "是否自动带当前时间（HH:MM），默认 true"},
			},
			"required": []string{"markdown"},
		},
	},
	{
		Name:        "trash_note",
		Description: "将备忘移入「最近删除」（软删除，保留 30 天可恢复，不会物理粉碎）。",
		scope:       "write",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"id": map[string]any{"type": "string", "description": "备忘 ID"},
			},
			"required": []string{"id"},
		},
	},
	{
		Name:        "list_todos",
		Description: "列出待办事项，可按完成状态、关键词或文件夹筛选。",
		scope:       "read",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"done":   map[string]any{"type": "string", "enum": []string{"all", "true", "false"}, "description": "筛选完成状态，默认 false（未完成）"},
				"query":  map[string]any{"type": "string", "description": "搜索关键词（可选）"},
				"folder": map[string]any{"type": "string", "description": "文件夹名称或 ID（可选）"},
				"limit":  map[string]any{"type": "integer", "description": "返回条数，默认 50"},
			},
		},
	},
	{
		Name:        "create_todo",
		Description: "创建一条新的待办事项。",
		scope:       "todo",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"title":  map[string]any{"type": "string", "description": "待办标题"},
				"note":   map[string]any{"type": "string", "description": "备注说明（可选）"},
				"folder": map[string]any{"type": "string", "description": "目标文件夹名称（可选）"},
				"pinned": map[string]any{"type": "boolean", "description": "是否置顶（可选）"},
			},
			"required": []string{"title"},
		},
	},
	{
		Name:        "update_todo",
		Description: "修改已有待办的标题、备注、完成状态、文件夹或置顶状态。",
		scope:       "todo",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"id":     map[string]any{"type": "string", "description": "待办 ID"},
				"title":  map[string]any{"type": "string", "description": "新标题（可选）"},
				"note":   map[string]any{"type": "string", "description": "新备注（可选）"},
				"done":   map[string]any{"type": "boolean", "description": "是否完成（可选）"},
				"folder": map[string]any{"type": "string", "description": "目标文件夹名称（可选）"},
				"pinned": map[string]any{"type": "boolean", "description": "是否置顶（可选）"},
			},
			"required": []string{"id"},
		},
	},
	{
		Name:        "complete_todo",
		Description: "将指定待办标记为已完成（或传 done=false 取消完成）。",
		scope:       "todo",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"id":   map[string]any{"type": "string", "description": "待办 ID"},
				"done": map[string]any{"type": "boolean", "description": "默认 true"},
			},
			"required": []string{"id"},
		},
	},
	{
		Name:        "trash_todo",
		Description: "将待办移入「最近删除」（软删除，保留 30 天可恢复）。",
		scope:       "todo",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"id": map[string]any{"type": "string", "description": "待办 ID"},
			},
			"required": []string{"id"},
		},
	},
}

func (a *app) handleMCP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == "DELETE" {
		w.WriteHeader(204)
		return
	}
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
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
	_, _ = a.db.Exec("UPDATE api_keys SET last_used_at=? WHERE id=?", now(), p.KeyID)

	var req mcpRequest
	if err := decodeLimit(w, r, &req, 512<<10); err != nil {
		output(w, 400, mcpResponse{JSONRPC: "2.0", Error: &mcpError{Code: -32700, Message: err.Error()}})
		return
	}
	if req.JSONRPC != "" && req.JSONRPC != "2.0" {
		output(w, 400, mcpResponse{JSONRPC: "2.0", ID: req.ID, Error: &mcpError{Code: -32600, Message: "invalid jsonrpc version"}})
		return
	}

	// JSON-RPC notifications (no id) return 202 Accepted.
	if req.ID == nil && (req.Method == "notifications/initialized" || req.Method == "notifications/cancelled") {
		w.WriteHeader(202)
		return
	}

	switch req.Method {
	case "initialize":
		proto := "2025-03-26"
		var initParams struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if len(req.Params) > 0 && json.Unmarshal(req.Params, &initParams) == nil && initParams.ProtocolVersion != "" {
			if initParams.ProtocolVersion == "2024-11-05" || initParams.ProtocolVersion == "2025-03-26" || initParams.ProtocolVersion == "2025-06-18" {
				proto = initParams.ProtocolVersion
			}
		}
		output(w, 200, mcpResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"protocolVersion": proto,
				"capabilities": map[string]any{
					"tools": map[string]any{},
				},
				"serverInfo": map[string]any{
					"name":    "yonote",
					"version": appVersion,
				},
			},
		})
	case "ping":
		output(w, 200, mcpResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{}})
	case "tools/list":
		allowed := make([]mcpToolDef, 0, len(yonoteMCPTools))
		for _, tool := range yonoteMCPTools {
			if p.hasScope(tool.scope) {
				allowed = append(allowed, tool)
			}
		}
		output(w, 200, mcpResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  map[string]any{"tools": allowed},
		})
	case "tools/call":
		var call struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &call); err != nil {
			output(w, 200, mcpResponse{JSONRPC: "2.0", ID: req.ID, Error: &mcpError{Code: -32602, Message: "参数格式错误"}})
			return
		}
		if call.Arguments == nil {
			call.Arguments = map[string]any{}
		}
		res, err := a.execMCPTool(p, call.Name, call.Arguments)
		if err != nil {
			output(w, 200, mcpResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result: map[string]any{
					"content": []map[string]any{{"type": "text", "text": err.Error()}},
					"isError": true,
				},
			})
			return
		}
		raw, _ := json.MarshalIndent(res, "", "  ")
		output(w, 200, mcpResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"content": []map[string]any{{"type": "text", "text": string(raw)}},
			},
		})
	default:
		output(w, 200, mcpResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &mcpError{Code: -32601, Message: "不支持的方法：" + req.Method},
		})
	}
}

func sliceNoteForMCP(note agentNoteDetail, offset, limit int) map[string]any {
	runes := []rune(note.Markdown)
	total := len(runes)
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	if limit <= 0 {
		limit = 4500
	}
	if limit < 500 {
		limit = 500
	}
	if limit > 20000 {
		limit = 20000
	}
	end := offset + limit
	if end > total {
		end = total
	}
	// Prefer breaking on a nearby newline so Markdown blocks stay clean across chunks.
	if end < total {
		searchStart := end - 200
		if searchStart < offset+250 {
			searchStart = offset + 250
		}
		for i := end; i > searchStart; i-- {
			if runes[i-1] == '\n' {
				end = i
				break
			}
		}
	}
	chunk := string(runes[offset:end])
	hasMore := end < total
	out := map[string]any{
		"id":            note.ID,
		"title":         note.Title,
		"markdown":      chunk,
		"folderId":      note.FolderID,
		"folder":        note.Folder,
		"pinned":        note.Pinned,
		"starred":       note.Starred,
		"updatedAt":     note.UpdatedAt,
		"version":       note.Version,
		"totalChars":    total,
		"offset":        offset,
		"returnedChars": end - offset,
		"hasMore":       hasMore,
	}
	if hasMore {
		out["nextOffset"] = end
	}
	return out
}

func (a *app) execMCPTool(p agentPrincipal, name string, args map[string]any) (any, error) {
	str := func(k string) string { s, _ := args[k].(string); return s }
	strPtr := func(k string) *string {
		if v, ok := args[k].(string); ok {
			return &v
		}
		return nil
	}
	boolVal := func(k string, def bool) bool {
		if v, ok := args[k].(bool); ok {
			return v
		}
		return def
	}
	boolPtr := func(k string) *bool {
		if v, ok := args[k].(bool); ok {
			return &v
		}
		return nil
	}
	intVal := func(k string, def int) int {
		if f, ok := args[k].(float64); ok {
			return int(f)
		}
		return def
	}

	require := func(scope string) error {
		if !p.hasScope(scope) {
			return apiError{403, "当前密钥缺少 " + scope + " 权限"}
		}
		return nil
	}

	switch name {
	case "list_folders":
		if e := require("read"); e != nil {
			return nil, e
		}
		return a.agentListFolders(p)
	case "list_notes":
		if e := require("read"); e != nil {
			return nil, e
		}
		return a.agentListNotes(p, str("query"), str("folder"), intVal("limit", 30))
	case "search_notes":
		if e := require("read"); e != nil {
			return nil, e
		}
		return a.agentListNotes(p, str("query"), str("folder"), intVal("limit", 20))
	case "read_note":
		if e := require("read"); e != nil {
			return nil, e
		}
		note, err := a.agentReadNote(p, str("id"))
		if err != nil {
			return nil, err
		}
		return sliceNoteForMCP(note, intVal("offset", 0), intVal("limit", 4500)), nil
	case "create_note":
		if e := require("write"); e != nil {
			return nil, e
		}
		return a.agentCreateNote(p, str("title"), str("markdown"), str("folderId"), str("folder"), boolVal("pinned", false), boolVal("starred", false))
	case "update_note":
		if e := require("write"); e != nil {
			return nil, e
		}
		return a.agentUpdateNote(p, str("id"), notePatch{
			Title:    strPtr("title"),
			Markdown: strPtr("markdown"),
			FolderID: strPtr("folderId"),
			Folder:   strPtr("folder"),
			Pinned:   boolPtr("pinned"),
			Starred:  boolPtr("starred"),
		})
	case "append_to_note":
		if e := require("write"); e != nil {
			return nil, e
		}
		return a.agentAppendNote(p, str("id"), str("markdown"), boolVal("timestamp", false))
	case "append_daily_diary":
		if e := require("write"); e != nil {
			return nil, e
		}
		return a.agentAppendDiary(p, str("markdown"), str("date"), str("folder"), boolVal("timestamp", true))
	case "trash_note":
		if e := require("write"); e != nil {
			return nil, e
		}
		if e := a.agentSoftDelete(p, "note", str("id")); e != nil {
			return nil, e
		}
		return map[string]any{"ok": true, "trashed": true}, nil
	case "list_todos":
		if e := require("read"); e != nil {
			return nil, e
		}
		doneFilter := str("done")
		if doneFilter == "" {
			doneFilter = "false"
		}
		if doneFilter == "all" {
			doneFilter = ""
		}
		return a.agentListTodos(p, doneFilter, str("query"), str("folder"), intVal("limit", 50))
	case "create_todo":
		if e := require("todo"); e != nil {
			return nil, e
		}
		return a.agentCreateTodo(p, str("title"), str("note"), str("folderId"), str("folder"), boolVal("pinned", false))
	case "update_todo":
		if e := require("todo"); e != nil {
			return nil, e
		}
		return a.agentUpdateTodo(p, str("id"), todoPatch{
			Title:    strPtr("title"),
			Note:     strPtr("note"),
			Done:     boolPtr("done"),
			FolderID: strPtr("folderId"),
			Folder:   strPtr("folder"),
			Pinned:   boolPtr("pinned"),
		})
	case "complete_todo":
		if e := require("todo"); e != nil {
			return nil, e
		}
		d := boolVal("done", true)
		return a.agentUpdateTodo(p, str("id"), todoPatch{Done: &d})
	case "trash_todo":
		if e := require("todo"); e != nil {
			return nil, e
		}
		if e := a.agentSoftDelete(p, "todo", str("id")); e != nil {
			return nil, e
		}
		return map[string]any{"ok": true, "trashed": true}, nil
	default:
		return nil, apiError{404, "未知工具：" + name}
	}
}
