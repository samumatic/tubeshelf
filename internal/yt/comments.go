package yt

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Comment is one top-level comment under a video.
type Comment struct {
	ID        string
	Author    string
	Text      string
	Published string // as YouTube words it: "3 days ago"
	Likes     string // "1.2K", "" when none
	Replies   string // "12 replies", "" when none
	Creator   bool   // written by the channel owner
	Pinned    bool
}

// CommentsPage is one page of comments. Next continues it; Newest and Top
// switch the order (only on the first page). Disabled means the video has no
// comment section.
type CommentsPage struct {
	Comments    []Comment
	Next        string
	Newest, Top string
	Disabled    bool
}

const maxCommentsPerPage = 20

// Comments fetches a page of comments through Innertube's "next" endpoint,
// the call YouTube's own watch page makes. token is empty for the first page,
// else a Next, Newest or Top token from an earlier page.
func (c *Client) Comments(ctx context.Context, videoID, token string) (*CommentsPage, error) {
	if token == "" {
		body, err := c.next(ctx, map[string]any{"videoId": videoID})
		if err != nil {
			return nil, err
		}
		token = firstCommentsToken(body)
		if token == "" {
			return &CommentsPage{Disabled: true}, nil
		}
	}
	body, err := c.next(ctx, map[string]any{"continuation": token})
	if err != nil {
		return nil, err
	}
	return parseComments(body), nil
}

func (c *Client) next(ctx context.Context, fields map[string]any) (any, error) {
	fields["context"] = map[string]any{"client": map[string]string{
		"clientName": "WEB", "clientVersion": "2.20250101.00.00", "hl": "en", "gl": "US",
	}}
	req, _ := json.Marshal(fields)
	raw, err := c.do(ctx, http.MethodPost, "/youtubei/v1/next?prettyPrint=false", req)
	if err != nil {
		return nil, err
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("youtube: parse next: %w", err)
	}
	return out, nil
}

// at walks a decoded JSON value by object keys and array indexes; it returns
// nil as soon as a step does not exist.
func at(v any, path ...any) any {
	for _, p := range path {
		switch k := p.(type) {
		case string:
			m, ok := v.(map[string]any)
			if !ok {
				return nil
			}
			v = m[k]
		case int:
			a, ok := v.([]any)
			if !ok || k < 0 || k >= len(a) {
				return nil
			}
			v = a[k]
		}
	}
	return v
}

func str(v any, path ...any) string {
	s, _ := at(v, path...).(string)
	return s
}

func list(v any, path ...any) []any {
	a, _ := at(v, path...).([]any)
	return a
}

// text reads YouTube's text objects: a string, {simpleText} or {runs: [{text}]}.
func text(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case map[string]any:
		if s, ok := t["simpleText"].(string); ok {
			return s
		}
		var b strings.Builder
		for _, r := range list(t, "runs") {
			if s := str(r, "text"); s != "" {
				b.WriteString(s)
			} else if s := str(r, "emoji", "shortcuts", 0); s != "" {
				b.WriteString(s)
			}
		}
		return strings.TrimSpace(b.String())
	}
	return ""
}

func continuationToken(item any) string {
	return str(item, "continuationItemRenderer", "continuationEndpoint", "continuationCommand", "token")
}

// firstCommentsToken finds the token that loads the comment section of a watch page.
func firstCommentsToken(data any) string {
	for _, entry := range list(data, "contents", "twoColumnWatchNextResults", "results", "results", "contents") {
		sec := at(entry, "itemSectionRenderer")
		if str(sec, "targetId") != "comments-section" && str(sec, "sectionIdentifier") != "comment-item-section" {
			continue
		}
		for _, c := range list(sec, "contents") {
			if tok := continuationToken(c); tok != "" {
				return tok
			}
		}
	}
	for _, p := range list(data, "engagementPanels") {
		panel := at(p, "engagementPanelSectionListRenderer")
		if str(panel, "panelIdentifier") != "engagement-panel-comments-section" {
			continue
		}
		if tok := continuationToken(at(panel, "content", "sectionListRenderer", "contents", 0, "itemSectionRenderer", "contents", 0)); tok != "" {
			return tok
		}
	}
	return ""
}

// walk calls fn on every object inside v.
func walk(v any, fn func(map[string]any)) {
	switch t := v.(type) {
	case map[string]any:
		fn(t)
		for _, c := range t {
			walk(c, fn)
		}
	case []any:
		for _, c := range t {
			walk(c, fn)
		}
	}
}

func parseComments(data any) *CommentsPage {
	var items []any
	for _, ep := range list(data, "onResponseReceivedEndpoints") {
		items = append(items, list(ep, "reloadContinuationItemsCommand", "continuationItems")...)
		items = append(items, list(ep, "appendContinuationItemsAction", "continuationItems")...)
	}
	items = append(items, list(data, "continuationContents", "itemSectionContinuation", "contents")...)

	// Newer responses keep the comment itself in an entity store, keyed by comment id.
	entities := map[string]any{}
	for _, m := range list(data, "frameworkUpdates", "entityBatchUpdate", "mutations") {
		e := at(m, "payload", "commentEntityPayload")
		if id := str(e, "properties", "commentId"); id != "" {
			entities[id] = e
		}
	}

	page := &CommentsPage{}
	walk(data, func(m map[string]any) {
		for _, it := range list(m, "sortFilterSubMenuRenderer", "subMenuItems") {
			tok := str(it, "serviceEndpoint", "continuationCommand", "token")
			switch title := strings.ToLower(str(it, "title")); {
			case tok == "":
			case strings.Contains(title, "new"):
				page.Newest = tok
			case strings.Contains(title, "top"):
				page.Top = tok
			}
		}
	})

	seen := map[string]bool{}
	add := func(c Comment) {
		if c.ID == "" || strings.TrimSpace(c.Text) == "" || seen[c.ID] || len(page.Comments) >= maxCommentsPerPage {
			return
		}
		seen[c.ID] = true
		page.Comments = append(page.Comments, c)
	}
	for _, it := range items {
		if tok := continuationToken(it); tok != "" {
			page.Next = tok // the last one continues the list
			continue
		}
		thread := at(it, "commentThreadRenderer")
		if thread == nil {
			if id := str(it, "commentViewModel", "commentId"); id != "" {
				add(entityComment(entities[id], false))
			}
			continue
		}
		vm := at(thread, "commentViewModel", "commentViewModel")
		pinned := at(vm, "pinnedText") != nil
		var c Comment
		if legacy := at(thread, "comment", "commentRenderer"); legacy != nil {
			c = legacyComment(legacy, pinned)
		} else {
			c = entityComment(entities[str(vm, "commentId")], pinned)
		}
		c.Replies = text(at(thread, "replies", "commentRepliesRenderer", "viewReplies", "buttonRenderer", "text"))
		add(c)
	}
	return page
}

func legacyComment(r any, pinned bool) Comment {
	likes := text(at(r, "voteCount"))
	return Comment{
		ID: str(r, "commentId"), Author: or(text(at(r, "authorText")), "Unknown"), Text: text(at(r, "contentText")),
		Published: text(at(r, "publishedTimeText")), Likes: likes,
		Creator: at(r, "authorIsChannelOwner") == true, Pinned: pinned,
	}
}

func entityComment(e any, pinned bool) Comment {
	if e == nil {
		return Comment{}
	}
	likes := str(e, "toolbar", "likeCountNotliked")
	if strings.TrimSpace(likes) == "0" {
		likes = ""
	}
	return Comment{
		ID: str(e, "properties", "commentId"), Author: or(str(e, "author", "displayName"), "Unknown"),
		Text: str(e, "properties", "content", "content"), Published: str(e, "properties", "publishedTime"),
		Likes: strings.TrimSpace(likes), Creator: at(e, "author", "isCreator") == true, Pinned: pinned,
	}
}

func or(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
