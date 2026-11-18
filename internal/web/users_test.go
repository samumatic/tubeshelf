package web

import (
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
