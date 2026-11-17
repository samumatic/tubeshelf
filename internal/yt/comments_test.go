package yt

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Shapes taken from v1's parser: YouTube serves comments either as legacy
// commentRenderer objects or as view models backed by an entity store.
const watchNext = `{"contents":{"twoColumnWatchNextResults":{"results":{"results":{"contents":[
  {"videoPrimaryInfoRenderer":{}},
  {"itemSectionRenderer":{"targetId":"comments-section","contents":[
    {"continuationItemRenderer":{"continuationEndpoint":{"continuationCommand":{"token":"FIRST"}}}}]}}]}}}}}`

const firstPage = `{
 "onResponseReceivedEndpoints":[
  {"reloadContinuationItemsCommand":{"continuationItems":[
   {"commentsHeaderRenderer":{"sortMenu":{"sortFilterSubMenuRenderer":{"subMenuItems":[
     {"title":"Top comments","serviceEndpoint":{"continuationCommand":{"token":"TOP"}}},
     {"title":"Newest first","serviceEndpoint":{"continuationCommand":{"token":"NEW"}}}]}}}}]}},
  {"reloadContinuationItemsCommand":{"continuationItems":[
   {"commentThreadRenderer":{"commentViewModel":{"commentViewModel":{"commentId":"c1","pinnedText":"Pinned by X"}},
     "replies":{"commentRepliesRenderer":{"viewReplies":{"buttonRenderer":{"text":{"runs":[{"text":"12 replies"}]}}}}}}},
   {"commentThreadRenderer":{"comment":{"commentRenderer":{"commentId":"c2","authorText":{"simpleText":"@legacy"},
     "contentText":{"runs":[{"text":"Hello "},{"text":"<b>world</b>"},{"emoji":{"shortcuts":[":wave:"]}}]},
     "publishedTimeText":{"runs":[{"text":"2 days ago"}]},"voteCount":{"simpleText":"5"},"authorIsChannelOwner":true}}}},
   {"commentThreadRenderer":{"commentViewModel":{"commentViewModel":{"commentId":"c1"}}}},
   {"commentThreadRenderer":{"commentViewModel":{"commentViewModel":{"commentId":"empty"}}}},
   {"continuationItemRenderer":{"continuationEndpoint":{"continuationCommand":{"token":"MORE"}}}}]}}],
 "frameworkUpdates":{"entityBatchUpdate":{"mutations":[
  {"payload":{"commentEntityPayload":{"properties":{"commentId":"c1","content":{"content":"First line\nsecond line"},"publishedTime":"1 hour ago"},
    "author":{"displayName":"@entity","isCreator":false},"toolbar":{"likeCountNotliked":"1.2K"}}}},
  {"payload":{"commentEntityPayload":{"properties":{"commentId":"empty","content":{"content":"  "}},"author":{"displayName":"@blank"}}}}]}}}`

func decode(t *testing.T, s string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestParseComments(t *testing.T) {
	if got := firstCommentsToken(decode(t, watchNext)); got != "FIRST" {
		t.Errorf("first token = %q", got)
	}
	p := parseComments(decode(t, firstPage))
	if p.Top != "TOP" || p.Newest != "NEW" || p.Next != "MORE" {
		t.Errorf("tokens: top %q newest %q next %q", p.Top, p.Newest, p.Next)
	}
	if len(p.Comments) != 2 {
		t.Fatalf("got %d comments, want 2 (duplicate and blank dropped): %+v", len(p.Comments), p.Comments)
	}
	c1, c2 := p.Comments[0], p.Comments[1]
	if c1.ID != "c1" || c1.Author != "@entity" || c1.Text != "First line\nsecond line" || !c1.Pinned ||
		c1.Likes != "1.2K" || c1.Replies != "12 replies" || c1.Published != "1 hour ago" {
		t.Errorf("entity comment: %+v", c1)
	}
	if c2.Author != "@legacy" || c2.Text != "Hello <b>world</b>:wave:" || !c2.Creator || c2.Likes != "5" || c2.Published != "2 days ago" {
		t.Errorf("legacy comment: %+v", c2)
	}
}

func TestParseCommentsCapsPage(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"onResponseReceivedEndpoints":[{"appendContinuationItemsAction":{"continuationItems":[`)
	for i := range 30 {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"commentThreadRenderer":{"comment":{"commentRenderer":{"commentId":"c` + strings.Repeat("x", i+1) + `","contentText":{"simpleText":"hi"}}}}}`)
	}
	b.WriteString(`]}}]}`)
	if n := len(parseComments(decode(t, b.String())).Comments); n != maxCommentsPerPage {
		t.Errorf("page has %d comments, want at most %d", n, maxCommentsPerPage)
	}
}

func TestCommentsRequests(t *testing.T) {
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(b))
		if strings.Contains(string(b), `"videoId"`) {
			io.WriteString(w, watchNext)
			return
		}
		io.WriteString(w, firstPage)
	}))
	defer srv.Close()
	c := &Client{HTTP: srv.Client(), BaseURL: srv.URL}

	p, err := c.Comments(context.Background(), "abcdefghijk", "")
	if err != nil || len(p.Comments) != 2 {
		t.Fatalf("first page: %v %+v", err, p)
	}
	if len(bodies) != 2 || !strings.Contains(bodies[1], `"continuation":"FIRST"`) {
		t.Errorf("first page should look up the section, then load it: %q", bodies)
	}
	bodies = nil
	if _, err := c.Comments(context.Background(), "abcdefghijk", "MORE"); err != nil || len(bodies) != 1 {
		t.Errorf("a later page is one request: %v %q", err, bodies)
	}
}

func TestCommentsDisabled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"contents":{"twoColumnWatchNextResults":{"results":{"results":{"contents":[{"itemSectionRenderer":{"targetId":"comments-section","contents":[{"messageRenderer":{}}]}}]}}}}}`)
	}))
	defer srv.Close()
	p, err := (&Client{HTTP: srv.Client(), BaseURL: srv.URL}).Comments(context.Background(), "abcdefghijk", "")
	if err != nil || !p.Disabled {
		t.Errorf("turned-off comments: %v %+v", err, p)
	}
}
