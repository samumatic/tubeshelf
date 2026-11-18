package web

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"testing"
)

// An admin adds someone without a password, hands over the invite link, and
// that person chooses a password through it exactly once.
func TestInviteFlow(t *testing.T) {
	a := newApp(t)
	a.signUp()
	_, body := a.post("/admin/users", url.Values{"email": {"kim@example.com"}, "name": {"Kim"}})
	m := regexp.MustCompile(`value="(http[^"]+/welcome\?t=[^"]+)"`).FindStringSubmatch(body)
	if m == nil {
		t.Fatal("no invite link after adding a user without a password")
	}
	link := strings.ReplaceAll(m[1], "&amp;", "&")
	u, _ := url.Parse(link)
	token := u.Query().Get("t")
	guest := a.as("admin@example.com", "correct horse") // fresh jar; sign out below
	guest.post("/logout", nil)
	if _, body := guest.get("/welcome?t=" + url.QueryEscape(token)); !strings.Contains(body, "kim@example.com") {
		t.Fatal("welcome page does not show the invited email")
	}
	guest.post("/welcome", url.Values{"t": {token}, "password": {"kim password"}})
	a.as("kim@example.com", "kim password")
	if _, body := guest.get("/welcome?t=" + url.QueryEscape(token)); !strings.Contains(body, "already used") {
		t.Error("an invite link works twice")
	}
}

func TestPauseAndMustChange(t *testing.T) {
	a := newApp(t)
	a.signUp()
	a.post("/admin/users", url.Values{"email": {"lee@example.com"}, "password": {"temporary pw"}, "must_change": {"1"}})
	lee := a.as("lee@example.com", "temporary pw")
	if _, body := lee.get("/"); !strings.Contains(body, "Choose your own password") {
		t.Error("a temporary password does not lead to the password form")
	}
	id := a.userID("lee@example.com")
	a.post("/admin/users/"+id, url.Values{"action": {"pause"}})
	if code, body := lee.get("/"); code == 200 && strings.Contains(body, "Sign out") {
		t.Error("a paused user keeps their session")
	}
	if _, body := lee.post("/login", url.Values{"email": {"lee@example.com"}, "password": {"temporary pw"}}); !strings.Contains(body, "paused") {
		t.Error("a paused user is not told why sign-in fails")
	}
	a.post("/admin/users/"+id, url.Values{"action": {"resume"}})
	a.as("lee@example.com", "temporary pw")
}

func TestInstanceDefaults(t *testing.T) {
	a := newApp(t)
	a.signUp()
	a.post("/admin/defaults", url.Values{"view": {"list"}, "hide_shorts": {"0"}})
	if code, _ := a.post("/admin/defaults", url.Values{"view": {"bogus"}}); code == 200 {
		if v := a.count(`SELECT count(*) FROM settings WHERE key = 'default.view' AND value = 'bogus'`); v != 0 {
			t.Error("an unknown default value was stored")
		}
	}
	a.post("/admin/users", url.Values{"email": {"new@example.com"}, "password": {"new password"}})
	n := a.as("new@example.com", "new password")
	if _, body := n.get("/account/preferences"); !strings.Contains(body, `value="list" checked`) && !strings.Contains(body, `value="list" selected`) {
		t.Error("an instance default does not reach a new user")
	}
}

func TestFailingChannelActions(t *testing.T) {
	a := newApp(t)
	a.signUp()
	a.db.Exec(`UPDATE channels SET fail_count = 4, last_error = 'gone'`)
	if _, body := a.get("/admin"); !strings.Contains(body, `id="failing"`) || !strings.Contains(body, "nav-dot") {
		t.Fatal("failing channels are not listed on Status")
	}
	a.post("/admin/channels/"+chanA+"/retry", nil)
	if a.count(`SELECT fail_count FROM channels WHERE id = ?`, chanA) != 0 {
		t.Error("retry does not reset the backoff")
	}
	a.post("/admin/channels/"+chanA+"/remove", url.Values{"confirm": {"1"}})
	if a.count(`SELECT count(*) FROM channels WHERE id = ?`, chanA) != 0 {
		t.Error("remove leaves the channel")
	}
}

func TestScrapeChannelButton(t *testing.T) {
	a := newApp(t)
	a.signUp()
	a.db.Exec(`UPDATE channels SET next_fetch_at = 999999999999`)
	if _, body := a.get("/channels"); !strings.Contains(body, `action="/channels/`+chanA+`/scrape"`) {
		t.Fatal("no scrape button on the channels page")
	}
	if code, _ := a.post("/channels/"+chanA+"/scrape", nil); code != 200 {
		t.Fatalf("scrape: status %d", code)
	}
	if a.count(`SELECT next_fetch_at FROM channels WHERE id = ?`, chanA) != 0 {
		t.Error("scrape does not make the channel due")
	}
	a.db.Exec(`DELETE FROM subscriptions`)
	a.db.Exec(`UPDATE channels SET next_fetch_at = 5`)
	a.post("/channels/"+chanA+"/scrape", nil)
	if a.count(`SELECT next_fetch_at FROM channels WHERE id = ?`, chanA) != 5 {
		t.Error("scraping a channel you don't follow touched it")
	}
}

// A link with ?err= or ?msg= made elsewhere must not put its text on the page.
func TestFlashCannotBeSpoofed(t *testing.T) {
	a := newApp(t)
	a.signUp()
	for _, q := range []string{"/?err=Your+account+is+locked", "/?msg=Call+support", "/login?err=Session+expired"} {
		if _, body := a.get(q); strings.Contains(body, "account is locked") || strings.Contains(body, "Call support") || strings.Contains(body, "Session expired") {
			t.Errorf("%s: unsigned message shown", q)
		}
	}
	if _, body := a.post("/lists", url.Values{"name": {"Music"}}); !strings.Contains(body, "Created “Music”") {
		t.Error("a message the server wrote is not shown")
	}
}

func TestHistoryPages(t *testing.T) {
	a := newApp(t)
	a.signUp()
	id := a.userID("admin@example.com")
	for i := range 70 {
		vid := fmt.Sprintf("hist%07d", i)
		a.db.Exec(`INSERT INTO videos (id, channel_id, title, published_at, kind) VALUES (?, ?, ?, 0, 'video')`, vid, chanA, "H"+vid)
		a.db.Exec(`INSERT INTO watch_state (user_id, video_id, progress, watched, updated_at) VALUES (?, ?, 5, 1, ?)`, id, vid, 1000+i)
	}
	_, body := a.get("/history")
	m := regexp.MustCompile(`id="more" class="more button" href="([^"]+)"`).FindStringSubmatch(body)
	if m == nil || strings.Count(body, `class="history-item"`) != 60 {
		t.Fatalf("first page: %d items, more link %v", strings.Count(body, `class="history-item"`), m != nil)
	}
	_, frag := a.get("/history" + strings.ReplaceAll(m[1], "&amp;", "&") + "&fragment=1")
	if n := strings.Count(frag, `class="history-item"`); n != 10 || strings.Contains(frag, `id="more"`) {
		t.Errorf("second page: %d items", n)
	}
}
