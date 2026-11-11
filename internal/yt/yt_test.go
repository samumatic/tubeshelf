package yt

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestParseFeed(t *testing.T) {
	body, err := os.ReadFile("testdata/feed.xml") // recorded from YouTube, trimmed
	if err != nil {
		t.Fatal(err)
	}
	f, err := parseFeed(body)
	if err != nil {
		t.Fatal(err)
	}
	if f.Title != "Daily Dose Of Internet" {
		t.Errorf("title = %q", f.Title)
	}
	if len(f.Videos) != 4 {
		t.Fatalf("got %d videos, want 4", len(f.Videos))
	}
	shorts := 0
	for _, v := range f.Videos {
		if len(v.ID) != 11 || v.Title == "" || v.Published.IsZero() {
			t.Errorf("incomplete video: %+v", v)
		}
		if v.Short {
			shorts++
		}
	}
	if shorts != 1 {
		t.Errorf("got %d shorts, want 1 (the entry linked as /shorts/)", shorts)
	}
}

func TestParseDetails(t *testing.T) {
	cases := []struct {
		name, body string
		want       Details
		err        bool
	}{
		{"video refused but length known",
			`{"playabilityStatus":{"status":"UNPLAYABLE"},"videoDetails":{"lengthSeconds":"916"}}`,
			Details{Seconds: 916}, false},
		{"live", `{"videoDetails":{"lengthSeconds":"0","isLive":true}}`, Details{Live: true}, false},
		{"upcoming", `{"videoDetails":{"lengthSeconds":"0","isUpcoming":true}}`, Details{Upcoming: true}, false},
		{"members only",
			`{"playabilityStatus":{"status":"UNPLAYABLE","reason":"Join this channel to get access to members-only content"},"videoDetails":{"lengthSeconds":"60"}}`,
			Details{Seconds: 60, MembersOnly: true}, false},
		{"login wall without details", `{"playabilityStatus":{"status":"LOGIN_REQUIRED"}}`, Details{}, true},
	}
	for _, c := range cases {
		got, err := parseDetails([]byte(c.body))
		if (err != nil) != c.err {
			t.Errorf("%s: err = %v", c.name, err)
			continue
		}
		if err == nil && *got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, *got, c.want)
		}
	}
	if _, err := parseDetails([]byte(`{"playabilityStatus":{"status":"ERROR"}}`)); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleted video: err = %v, want ErrNotFound", err)
	}
}

func TestChannelPath(t *testing.T) {
	ok := map[string]string{
		"UCdC0An4ZPNr_YiFiYoVbwaw": "/channel/UCdC0An4ZPNr_YiFiYoVbwaw",
		"@veritasium":              "/@veritasium",
		" https://www.youtube.com/@veritasium/videos ":              "/@veritasium",
		"youtube.com/channel/UCdC0An4ZPNr_YiFiYoVbwaw":              "/channel/UCdC0An4ZPNr_YiFiYoVbwaw",
		"https://m.youtube.com/c/SomeName":                          "/c/SomeName",
		"https://www.youtube.com/user/SomeUser?feature=share":       "/user/SomeUser",
		"https://www.youtube.com/channel/UCdC0An4ZPNr_YiFiYoVbwaw/": "/channel/UCdC0An4ZPNr_YiFiYoVbwaw",
	}
	for in, want := range ok {
		if got, err := channelPath(in); err != nil || got != want {
			t.Errorf("channelPath(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"https://evil.example/@x", "https://www.youtube.com/watch?v=abc", "veritasium", "https://youtube.com.evil.example/@x"} {
		if got, err := channelPath(in); err == nil {
			t.Errorf("channelPath(%q) = %q, want error", in, got)
		}
	}
}

func TestResolveAndNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/@known" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Cookie") == "" {
			t.Error("consent cookie missing")
		}
		w.Write([]byte(`<html><head><link rel="canonical" href="https://www.youtube.com/channel/UCdC0An4ZPNr_YiFiYoVbwaw">
			<meta property="og:title" content="Tom &amp; Jerry"><meta property="og:image" content="https://yt3.googleusercontent.com/abc=s900-c-k"></head></html>`))
	}))
	defer srv.Close()
	c := &Client{HTTP: srv.Client(), BaseURL: srv.URL}

	ch, err := c.Resolve(context.Background(), "@known")
	if err != nil {
		t.Fatal(err)
	}
	if ch.ID != "UCdC0An4ZPNr_YiFiYoVbwaw" || ch.Title != "Tom & Jerry" || ch.Thumbnail == "" {
		t.Errorf("got %+v", ch)
	}
	if _, err := c.Resolve(context.Background(), "@missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing channel: err = %v, want ErrNotFound", err)
	}
}
