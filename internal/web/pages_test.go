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
