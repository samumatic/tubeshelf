package web

import (
	"testing"
	"time"
)

func TestGroupByDay(t *testing.T) {
	now := time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)
	at := func(d time.Duration) int64 { return now.Add(d).Unix() }
	vids := []Video{
		{ID: "a", Published: at(-1 * time.Hour)},
		{ID: "b", Published: at(-14 * time.Hour)}, // 01:00 today
		{ID: "c", Published: at(-16 * time.Hour)}, // 23:00 yesterday
		{ID: "d", Published: at(-3 * 24 * time.Hour)},
		{ID: "e", Published: at(-30 * 24 * time.Hour)},
		{ID: "f", Published: at(-400 * 24 * time.Hour)},
	}
	got := groupByDay(vids, now, "")
	want := []string{"Today", "Yesterday", "Monday", "13 October", "8 October 2025"}
	if len(got) != len(want) {
		t.Fatalf("got %d groups, want %d: %+v", len(got), len(want), got)
	}
	for i, g := range got {
		if g.Label != want[i] {
			t.Errorf("group %d = %q, want %q", i, g.Label, want[i])
		}
	}
	if len(got[0].Videos) != 2 {
		t.Errorf("Today has %d videos, want 2", len(got[0].Videos))
	}
	// The next page continues "Yesterday": no second heading for it.
	page2 := groupByDay(vids[2:], now, "Yesterday")
	if page2[0].Label != "" || page2[1].Label != "Monday" {
		t.Errorf("continued day repeated its heading: %+v", page2)
	}
	if l := dayLabel(at(48*time.Hour), now); l != "Upcoming" {
		t.Errorf("future video = %q, want Upcoming", l)
	}
}

// Sparse days are merged into weeks and months, so the grid is not one card per row.
func TestFeedLabelerMergesSparseDays(t *testing.T) {
	now := time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)
	at := func(days int) Video { return Video{Published: now.Add(-time.Duration(days) * 24 * time.Hour).Unix()} }
	sparse := []Video{at(0), at(3), at(4), at(9), at(20), at(40), at(400)}
	got := groupBy(sparse, feedLabeler(sparse, now), "")
	want := []string{"Today", "This week", "Last week", "October", "October 2025"}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i, g := range got {
		if g.Label != want[i] {
			t.Errorf("group %d = %q, want %q", i, g.Label, want[i])
		}
	}
	busy := []Video{at(0), at(0), at(0), at(1), at(1), at(1)}
	if l := feedLabeler(busy, now)(busy[3].Published); l != "Yesterday" {
		t.Errorf("busy days keep day headings, got %q", l)
	}
}

func TestLinkify(t *testing.T) {
	got := string(linkify(`See https://example.com/a?b=1&c=2. <b>x</b> (https://x.org)`))
	want := `See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener nofollow ugc">https://example.com/a?b=1&amp;c=2</a>. &lt;b&gt;x&lt;/b&gt; (<a href="https://x.org" target="_blank" rel="noopener nofollow ugc">https://x.org</a>)`
	if got != want {
		t.Errorf("linkify:\n got %s\nwant %s", got, want)
	}
	if got := string(linkify(`javascript:alert(1) "https://a.b/"onmouseover=x`)); got != `javascript:alert(1) &#34;<a href="https://a.b/" target="_blank" rel="noopener nofollow ugc">https://a.b/</a>&#34;onmouseover=x` {
		t.Errorf("unsafe input: %s", got)
	}
}
