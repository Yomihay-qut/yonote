package main

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	reHeading    = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	reTaskItem   = regexp.MustCompile(`^[-*+]\s+\[([ xX])\]\s*(.*)$`)
	reBulletItem = regexp.MustCompile(`^[-*+]\s+(.*)$`)
	reOrderItem  = regexp.MustCompile(`^\d+\.\s+(.*)$`)
	reHR         = regexp.MustCompile(`^\s*([-*_])(\s*-|\s*\*|\s*_){2,}\s*$`)
)

// markdownToDoc converts standard Markdown into a valid TipTap/ProseMirror JSON document.
func markdownToDoc(md string) map[string]any {
	md = strings.ReplaceAll(md, "\r\n", "\n")
	md = strings.ReplaceAll(md, "\r", "\n")
	lines := strings.Split(md, "\n")
	nodes := []any{}
	i := 0
	for i < len(lines) {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			i++
			continue
		}
		// Fenced code block
		if strings.HasPrefix(trimmed, "```") {
			lang := strings.TrimSpace(strings.TrimPrefix(trimmed, "```"))
			i++
			var codeLines []string
			for i < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[i]), "```") {
				codeLines = append(codeLines, lines[i])
				i++
			}
			if i < len(lines) {
				i++
			}
			attrs := map[string]any{}
			if lang != "" {
				attrs["language"] = lang
			}
			node := map[string]any{"type": "codeBlock", "attrs": attrs}
			code := strings.Join(codeLines, "\n")
			if code != "" {
				node["content"] = []any{map[string]any{"type": "text", "text": code}}
			}
			nodes = append(nodes, node)
			continue
		}
		// Horizontal rule
		if reHR.MatchString(line) {
			nodes = append(nodes, map[string]any{"type": "horizontalRule"})
			i++
			continue
		}
		// Heading
		if m := reHeading.FindStringSubmatch(line); m != nil {
			nodes = append(nodes, map[string]any{
				"type":    "heading",
				"attrs":   map[string]any{"level": len(m[1])},
				"content": parseInline(m[2]),
			})
			i++
			continue
		}
		// Blockquote
		if strings.HasPrefix(trimmed, ">") {
			var quoteLines []string
			for i < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[i]), ">") {
				q := strings.TrimSpace(lines[i])
				q = strings.TrimPrefix(q, ">")
				q = strings.TrimPrefix(q, " ")
				quoteLines = append(quoteLines, q)
				i++
			}
			inner := markdownToDoc(strings.Join(quoteLines, "\n"))
			nodes = append(nodes, map[string]any{
				"type":    "blockquote",
				"content": inner["content"],
			})
			continue
		}
		// Task list
		if reTaskItem.MatchString(trimmed) {
			var items []any
			for i < len(lines) {
				m := reTaskItem.FindStringSubmatch(strings.TrimSpace(lines[i]))
				if m == nil {
					break
				}
				checked := m[1] == "x" || m[1] == "X"
				items = append(items, map[string]any{
					"type":  "taskItem",
					"attrs": map[string]any{"checked": checked},
					"content": []any{
						paragraphNode(m[2]),
					},
				})
				i++
			}
			nodes = append(nodes, map[string]any{"type": "taskList", "content": items})
			continue
		}
		// Bullet list
		if reBulletItem.MatchString(trimmed) {
			var items []any
			for i < len(lines) {
				t := strings.TrimSpace(lines[i])
				if reTaskItem.MatchString(t) {
					break
				}
				m := reBulletItem.FindStringSubmatch(t)
				if m == nil {
					break
				}
				items = append(items, map[string]any{
					"type":    "listItem",
					"content": []any{paragraphNode(m[1])},
				})
				i++
			}
			nodes = append(nodes, map[string]any{"type": "bulletList", "content": items})
			continue
		}
		// Ordered list
		if reOrderItem.MatchString(trimmed) {
			var items []any
			for i < len(lines) {
				m := reOrderItem.FindStringSubmatch(strings.TrimSpace(lines[i]))
				if m == nil {
					break
				}
				items = append(items, map[string]any{
					"type":    "listItem",
					"content": []any{paragraphNode(m[1])},
				})
				i++
			}
			nodes = append(nodes, map[string]any{"type": "orderedList", "content": items})
			continue
		}
		// Regular paragraph (each non-empty line becomes a paragraph to match mobile note ergonomics)
		nodes = append(nodes, paragraphNode(line))
		i++
	}
	if len(nodes) == 0 {
		nodes = []any{map[string]any{"type": "paragraph"}}
	}
	return map[string]any{"type": "doc", "content": nodes}
}

func paragraphNode(text string) map[string]any {
	inline := parseInline(text)
	if len(inline) == 0 {
		return map[string]any{"type": "paragraph"}
	}
	return map[string]any{"type": "paragraph", "content": inline}
}

// parseInline converts basic inline Markdown (**bold**, *italic*, ~~strike~~, `code`) to TipTap text nodes.
func parseInline(s string) []any {
	if s == "" {
		return nil
	}
	var out []any
	addText := func(txt string, marks ...map[string]any) {
		if txt == "" {
			return
		}
		n := map[string]any{"type": "text", "text": txt}
		if len(marks) > 0 {
			ms := make([]any, len(marks))
			for i, m := range marks {
				ms[i] = m
			}
			n["marks"] = ms
		}
		out = append(out, n)
	}
	var buf strings.Builder
	flush := func() {
		if buf.Len() > 0 {
			addText(buf.String())
			buf.Reset()
		}
	}
	for i := 0; i < len(s); {
		// Inline code `...`
		if s[i] == '`' {
			if end := strings.IndexByte(s[i+1:], '`'); end > 0 {
				flush()
				addText(s[i+1:i+1+end], map[string]any{"type": "code"})
				i += end + 2
				continue
			}
		}
		// Bold **...**
		if i+1 < len(s) && s[i] == '*' && s[i+1] == '*' {
			if end := strings.Index(s[i+2:], "**"); end > 0 {
				flush()
				addText(s[i+2:i+2+end], map[string]any{"type": "bold"})
				i += end + 4
				continue
			}
		}
		// Strike ~~...~~
		if i+1 < len(s) && s[i] == '~' && s[i+1] == '~' {
			if end := strings.Index(s[i+2:], "~~"); end > 0 {
				flush()
				addText(s[i+2:i+2+end], map[string]any{"type": "strike"})
				i += end + 4
				continue
			}
		}
		// Italic *...*
		if s[i] == '*' && (i+1 >= len(s) || s[i+1] != '*') {
			if end := strings.IndexByte(s[i+1:], '*'); end > 0 {
				flush()
				addText(s[i+1:i+1+end], map[string]any{"type": "italic"})
				i += end + 2
				continue
			}
		}
		buf.WriteByte(s[i])
		i++
	}
	flush()
	return out
}

// appendMarkdownToDoc appends parsed Markdown blocks onto an existing TipTap document without disturbing existing nodes.
func appendMarkdownToDoc(existing any, md string) map[string]any {
	extra := markdownToDoc(md)
	extraNodes, _ := extra["content"].([]any)
	doc, ok := existing.(map[string]any)
	if !ok || doc["type"] != "doc" {
		return extra
	}
	baseNodes, _ := doc["content"].([]any)
	// Strip single trailing empty paragraph if the note is currently blank.
	if len(baseNodes) == 1 {
		if p, ok := baseNodes[0].(map[string]any); ok && p["type"] == "paragraph" && len(asSlice(p["content"])) == 0 {
			baseNodes = nil
		}
	}
	merged := make([]any, 0, len(baseNodes)+len(extraNodes))
	merged = append(merged, baseNodes...)
	merged = append(merged, extraNodes...)
	if len(merged) == 0 {
		merged = []any{map[string]any{"type": "paragraph"}}
	}
	return map[string]any{"type": "doc", "content": merged}
}

// docToMarkdown renders a TipTap JSON document into clean Markdown for AI agents.
func docToMarkdown(v any) string {
	node, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	if node["type"] == "doc" {
		parts := []string{}
		for _, child := range asSlice(node["content"]) {
			s := strings.TrimRight(renderBlock(child, ""), "\n")
			if s != "" {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "\n\n")
	}
	return strings.TrimRight(renderBlock(node, ""), "\n")
}

func renderBlock(v any, indent string) string {
	node, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	typ, _ := node["type"].(string)
	attrs, _ := node["attrs"].(map[string]any)
	children := asSlice(node["content"])
	switch typ {
	case "paragraph":
		return indent + renderInline(children)
	case "heading":
		lvl := 1
		if f, ok := attrs["level"].(float64); ok && f >= 1 && f <= 6 {
			lvl = int(f)
		} else if n, ok := attrs["level"].(int); ok && n >= 1 && n <= 6 {
			lvl = n
		}
		return indent + strings.Repeat("#", lvl) + " " + renderInline(children)
	case "bulletList":
		var lines []string
		for _, item := range children {
			lines = append(lines, renderListItem(item, indent, "- "))
		}
		return strings.Join(lines, "\n")
	case "orderedList":
		var lines []string
		for i, item := range children {
			lines = append(lines, renderListItem(item, indent, fmt.Sprintf("%d. ", i+1)))
		}
		return strings.Join(lines, "\n")
	case "taskList":
		var lines []string
		for _, item := range children {
			m, _ := item.(map[string]any)
			ia, _ := m["attrs"].(map[string]any)
			box := "- [ ] "
			if b, _ := ia["checked"].(bool); b {
				box = "- [x] "
			}
			lines = append(lines, renderListItem(item, indent, box))
		}
		return strings.Join(lines, "\n")
	case "blockquote":
		var lines []string
		for _, child := range children {
			block := renderBlock(child, "")
			for _, l := range strings.Split(block, "\n") {
				lines = append(lines, indent+"> "+l)
			}
		}
		return strings.Join(lines, "\n")
	case "codeBlock":
		lang, _ := attrs["language"].(string)
		return indent + "```" + lang + "\n" + renderInline(children) + "\n" + indent + "```"
	case "horizontalRule":
		return indent + "---"
	case "image":
		id, _ := attrs["attachmentId"].(string)
		alt, _ := attrs["alt"].(string)
		if alt == "" {
			alt = "图片"
		}
		if id != "" {
			return fmt.Sprintf("%s![%s](attachment:%s)", indent, alt, id)
		}
		src, _ := attrs["src"].(string)
		return fmt.Sprintf("%s![%s](%s)", indent, alt, src)
	case "attachment":
		id, _ := attrs["attachmentId"].(string)
		name, _ := attrs["name"].(string)
		if name == "" {
			name = "附件"
		}
		return fmt.Sprintf("%s[%s](attachment:%s)", indent, name, id)
	default:
		if len(children) > 0 {
			var parts []string
			for _, c := range children {
				if s := renderBlock(c, indent); s != "" {
					parts = append(parts, s)
				}
			}
			return strings.Join(parts, "\n")
		}
		return ""
	}
}

func renderListItem(item any, indent, prefix string) string {
	m, ok := item.(map[string]any)
	if !ok {
		return ""
	}
	children := asSlice(m["content"])
	if len(children) == 0 {
		return indent + prefix
	}
	first := renderBlock(children[0], "")
	out := []string{indent + prefix + first}
	for _, c := range children[1:] {
		out = append(out, renderBlock(c, indent+"  "))
	}
	return strings.Join(out, "\n")
}

func renderInline(children []any) string {
	var b strings.Builder
	for _, c := range children {
		n, ok := c.(map[string]any)
		if !ok {
			continue
		}
		typ, _ := n["type"].(string)
		switch typ {
		case "text":
			txt, _ := n["text"].(string)
			for _, m := range asSlice(n["marks"]) {
				mm, _ := m.(map[string]any)
				switch mm["type"] {
				case "code":
					txt = "`" + txt + "`"
				case "bold":
					txt = "**" + txt + "**"
				case "italic":
					txt = "*" + txt + "*"
				case "strike":
					txt = "~~" + txt + "~~"
				}
			}
			b.WriteString(txt)
		case "hardBreak":
			b.WriteString("\n")
		case "image":
			attrs, _ := n["attrs"].(map[string]any)
			id, _ := attrs["attachmentId"].(string)
			if id != "" {
				b.WriteString(fmt.Sprintf("![图片](attachment:%s)", id))
			}
		}
	}
	return b.String()
}

// docPlainText extracts searchable plain text from a TipTap JSON document.
func docPlainText(v any) string {
	node, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	if txt, ok := node["text"].(string); ok {
		return txt
	}
	children := asSlice(node["content"])
	if len(children) == 0 {
		return ""
	}
	sep := ""
	typ, _ := node["type"].(string)
	if typ == "doc" || typ == "bulletList" || typ == "orderedList" || typ == "taskList" || typ == "blockquote" {
		sep = "\n"
	}
	parts := make([]string, 0, len(children))
	for _, c := range children {
		if s := docPlainText(c); s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, sep)
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}
