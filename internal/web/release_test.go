package web

// Regression tests written before the 2.0 release. Each one describes
// something a user would notice going wrong.

import (
	"fmt"
	"html"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/samumatic/tubeshelf/internal/auth"
)

// as signs in as an existing user with its own cookie jar.
func (a *app) as(email, pw string) *app {
	a.t.Helper()
	jar, _ := cookiejar.New(nil)
	u := &app{t: a.t, db: a.db, url: a.url, c: &http.Client{Jar: jar}}
	if _, body := u.post("/login", url.Values{"email": {email}, "password": {pw}}); strings.Contains(body, `role="alert"`) {
		a.t.Fatalf("login as %s failed", email)
	}
	return u
}

func (a *app) count(q string, args ...any) (n int) {
	a.t.Helper()
	if err := a.db.QueryRow(q, args...).Scan(&n); err != nil {
		a.t.Fatal(err)
	}
	return n
}

func (a *app) userID(email string) (id string) {
	a.db.QueryRow(`SELECT id FROM users WHERE email = ?`, email).Scan(&id)
	return id
}

// A setup form sent without a password must not leave an admin behind that
// nobody can sign in as (setup would be closed for good).
func TestSetupWithoutPasswordCreatesNoUser(t *testing.T) {
	a := newApp(t)
	a.post("/setup", url.Values{"email": {"admin@example.com"}, "password": {""}})
	if n := a.count(`SELECT count(*) FROM users`); n != 0 {
		t.Fatalf("setup without a password created %d user(s), instance is now locked", n)
	}
	if _, body := a.get("/setup"); !strings.Contains(body, "This account becomes the administrator") {
		t.Error("setup is no longer reachable after a rejected attempt")
	}
}

// Once set up, POST /setup must not create another admin.
func TestSetupCannotBeRepeated(t *testing.T) {
	a := newApp(t)
	a.signUp()
	anon := &app{t: t, db: a.db, url: a.url, c: &http.Client{}}
	anon.post("/setup", url.Values{"email": {"evil@example.com"}, "password": {"correct horse"}})
	if a.count(`SELECT count(*) FROM users WHERE email = 'evil@example.com'`) != 0 {
		t.Fatal("second setup created a user")
	}
}

// Clicking a channel name filters by that exact channel (port of v1 #338):
// "DAVE" must not also show "Dave2D". Text search stays a substring search.
func TestChannelFilterIsExact(t *testing.T) {
	a := newApp(t)
	a.signUp()
	const davePad, dave2dPad = "UCdavedavedavedavedaveaa", "UCdave2ddave2ddave2ddaaa"
	now := time.Now().Unix()
	for _, c := range [][2]string{{davePad, "DAVE"}, {dave2dPad, "Dave2D"}} {
		a.db.Exec(`INSERT INTO channels (id, title) VALUES (?, ?)`, c[0], c[1])
		a.db.Exec(`INSERT INTO subscriptions (user_id, channel_id, added_at) SELECT id, ?, 0 FROM users`, c[0])
	}
	a.db.Exec(`INSERT INTO videos (id, channel_id, title, published_at) VALUES
		('davevideo01', ?, 'From DAVE', ?), ('dave2dvid01', ?, 'From Dave2D', ?)`, davePad, now, dave2dPad, now)

	_, body := a.get("/?channel=" + davePad)
	if !strings.Contains(body, "From DAVE") {
		t.Error("channel filter misses the channel's own video")
	}
	if strings.Contains(body, "From Dave2D") {
		t.Error("channel filter also shows a channel whose name merely contains it")
	}
	if _, body := a.get("/?q=dave"); !strings.Contains(body, "From DAVE") || !strings.Contains(body, "From Dave2D") {
		t.Error("text search no longer matches channel names as substrings")
	}
}

// Every per-user object must be out of reach for other users.
func TestUsersCannotTouchEachOthersData(t *testing.T) {
	a := newApp(t)
	a.signUp()
	admin := a.userID("admin@example.com")
	a.post("/lists", url.Values{"name": {"Admin list"}})
	var listID int64
	a.db.QueryRow(`SELECT id FROM lists WHERE user_id = ?`, admin).Scan(&listID)
	a.post(fmt.Sprintf("/lists/%d/channels", listID), url.Values{"channel": {chanA}, "on": {"1"}})
	keyID := ""
	auth.NewAPIKey(a.db, admin, "admin key")
	a.db.QueryRow(`SELECT id FROM api_keys WHERE user_id = ?`, admin).Scan(&keyID)
	a.post("/videos/video000001/later", url.Values{"on": {"1"}})
	a.post("/videos/video000001/watched", url.Values{"on": {"1"}})

	auth.CreateUser(a.db, "bob@example.com", "", "correct horse", false)
	bob := a.as("bob@example.com", "correct horse")
	// Bob subscribes to the same channel, so list and feed checks are meaningful.
	a.db.Exec(`INSERT INTO subscriptions (user_id, channel_id, added_at) VALUES (?, ?, 0)`, a.userID("bob@example.com"), chanA)

	bob.post(fmt.Sprintf("/lists/%d/delete", listID), nil)
	if a.count(`SELECT count(*) FROM lists WHERE id = ?`, listID) != 1 {
		t.Error("another user deleted the admin's list")
	}
	bob.post(fmt.Sprintf("/lists/%d/channels", listID), url.Values{"channel": {chanA}, "on": {"0"}})
	if a.count(`SELECT count(*) FROM list_channels WHERE list_id = ?`, listID) != 1 {
		t.Error("another user removed a channel from the admin's list")
	}
	bob.post("/account/keys/"+keyID+"/delete", nil)
	if a.count(`SELECT count(*) FROM api_keys WHERE id = ?`, keyID) != 1 {
		t.Error("another user deleted the admin's API key")
	}
	if _, body := bob.get(fmt.Sprintf("/?list=%d", listID)); strings.Contains(body, "Regular") {
		t.Error("another user's list filter leaks into the feed")
	}
	if _, body := bob.get("/later"); strings.Contains(body, "Regular") {
		t.Error("watch later is shared between users")
	}
	if _, body := bob.get("/history"); strings.Contains(body, "Regular") {
		t.Error("history is shared between users")
	}
	bob.post("/account/danger", url.Values{"confirm": {"1"}, "action": {"subscriptions"}})
	if a.count(`SELECT count(*) FROM subscriptions WHERE user_id = ?`, admin) != 1 ||
		a.count(`SELECT count(*) FROM list_channels WHERE list_id = ?`, listID) != 1 {
		t.Error("one user's danger zone deleted another user's subscriptions or lists")
	}
}

// A deleted account must lose its sessions and API keys at once.
func TestDeletedUserLosesAccess(t *testing.T) {
	a := newApp(t)
	a.signUp()
	auth.CreateUser(a.db, "bob@example.com", "", "correct horse", false)
	bob := a.as("bob@example.com", "correct horse")
	key, _ := auth.NewAPIKey(a.db, a.userID("bob@example.com"), "script")

	a.post("/admin/users/"+a.userID("bob@example.com"), url.Values{"action": {"delete"}, "confirm": {"1"}})
	if a.count(`SELECT count(*) FROM users WHERE email = 'bob@example.com'`) != 0 {
		t.Fatal("admin could not delete the user")
	}
	if code, _ := bob.post("/videos/video000001/later", url.Values{"on": {"1"}}); code != http.StatusUnauthorized {
		t.Errorf("deleted user's session still works: status %d", code)
	}
	req, _ := http.NewRequest(http.MethodGet, a.url+"/api/subscriptions", nil)
	req.Header.Set("X-API-Key", key)
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusUnauthorized {
		t.Errorf("deleted user's API key still works")
	}
}

// The only admin cannot delete themselves, or nobody could administer the instance.
func TestOnlyAdminCannotDeleteOwnAccount(t *testing.T) {
	a := newApp(t)
	a.signUp()
	a.post("/account/danger", url.Values{"confirm": {"1"}, "action": {"account"}})
	if a.count(`SELECT count(*) FROM users WHERE is_admin = 1`) != 1 {
		t.Fatal("the only admin deleted their own account")
	}
	// Without the confirmation box nothing happens either.
	a.post("/account/danger", url.Values{"action": {"history"}})
	a.post("/videos/video000001/watched", url.Values{"on": {"1"}})
	a.post("/account/danger", url.Values{"action": {"history"}})
	if a.count(`SELECT count(*) FROM watch_state`) != 1 {
		t.Error("danger action ran without the confirmation box")
	}
}

// With "OIDC only" on and a provider configured, password login and
// registration are closed, also when the form is posted directly.
func TestOIDCOnlyClosesPasswordLogin(t *testing.T) {
	a := newApp(t)
	a.signUp()
	a.db.Exec(`INSERT INTO oidc_providers (id, name, issuer, client_id, client_secret) VALUES ('p1', 'IdP', 'https://idp.example', 'c', 'x')`)
	a.post("/admin/settings", url.Values{"oidc_only": {"0", "1"}, "public_registration": {"0", "1"}})

	anon := &app{t: t, db: a.db, url: a.url, c: &http.Client{}}
	if _, body := anon.post("/login", url.Values{"email": {"admin@example.com"}, "password": {"correct horse"}}); !strings.Contains(body, "Password login is disabled.") {
		t.Error("password login still works with OIDC only")
	}
	anon.post("/register", url.Values{"email": {"new@example.com"}, "password": {"correct horse"}})
	if a.count(`SELECT count(*) FROM users WHERE email = 'new@example.com'`) != 0 {
		t.Error("registration still works with OIDC only")
	}

	// Deleting the last provider reopens password login instead of locking everyone out.
	a.post("/admin/providers/p1/delete", nil)
	if _, body := anon.post("/login", url.Values{"email": {"admin@example.com"}, "password": {"correct horse"}}); strings.Contains(body, "Password login is disabled.") {
		t.Error("deleting the only provider left password login disabled")
	}
}

func TestRegistrationClosedByDefault(t *testing.T) {
	a := newApp(t)
	a.signUp()
	anon := &app{t: t, db: a.db, url: a.url, c: &http.Client{}}
	if code, _ := anon.post("/register", url.Values{"email": {"new@example.com"}, "password": {"correct horse"}}); code != http.StatusForbidden {
		t.Errorf("register with registration off: status %d, want 403", code)
	}
	if a.count(`SELECT count(*) FROM users`) != 1 {
		t.Error("registration created a user although it is off")
	}
}

// Behind a proxy, X-Forwarded-For's first entry is whatever the client sent.
// Rotating it must not reset the login limit.
func TestLoginLimitIgnoresSpoofedForwardedFor(t *testing.T) {
	t.Setenv("TRUST_PROXY_HEADERS", "1")
	a := newApp(t)
	a.signUp()
	anon := &app{t: t, db: a.db, url: a.url, c: &http.Client{}}
	limited := false
	for i := range 15 {
		_, body := anon.post("/login", url.Values{"email": {"admin@example.com"}, "password": {"wrong"}},
			"X-Forwarded-For", fmt.Sprintf("10.0.0.%d, 203.0.113.9", i))
		limited = limited || strings.Contains(body, "Too many attempts")
	}
	if !limited {
		t.Error("15 failed logins from one client were never limited: the spoofable first X-Forwarded-For entry is used")
	}
}

// Everyone behind one proxy shares an IP: successful sign-ins must not lock the others out.
func TestSuccessfulLoginsAreNotLimited(t *testing.T) {
	a := newApp(t)
	a.signUp()
	for i := range 15 {
		anon := &app{t: t, db: a.db, url: a.url, c: &http.Client{}}
		if _, body := anon.post("/login", url.Values{"email": {"admin@example.com"}, "password": {"correct horse"}}); strings.Contains(body, "Too many attempts") {
			t.Fatalf("sign-in %d refused as too many attempts", i+1)
		}
	}
}

// The player posts its position; garbage must neither be stored nor break pages.
func TestProgressRejectsNonFiniteValues(t *testing.T) {
	a := newApp(t)
	a.signUp()
	for _, v := range []url.Values{
		{"t": {"NaN"}, "d": {"600"}},
		{"t": {"Inf"}, "d": {"600"}},
		{"t": {"10"}, "d": {"NaN"}},
		{"t": {"10"}, "d": {"-Inf"}},
		{"t": {"10"}, "d": {"-5"}},
	} {
		if code, _ := a.post("/videos/video000001/progress", v); code != http.StatusBadRequest {
			t.Errorf("progress %v: status %d, want 400", v, code)
		}
	}
	if n := a.count(`SELECT count(*) FROM watch_state`); n != 0 {
		t.Errorf("bad progress stored %d row(s)", n)
	}
	if a.count(`SELECT count(*) FROM videos WHERE duration_seconds IS NOT 600 AND id = 'video000001'`) != 0 {
		t.Error("bad progress changed the stored duration")
	}
	for _, p := range []string{"/", "/history", "/watch/video000001"} {
		if code, _ := a.get(p); code != http.StatusOK {
			t.Errorf("%s after bad progress: status %d", p, code)
		}
	}
}

// Paging through the feed shows every video exactly once, also when many
// share a timestamp, in both sort orders.
func TestFeedPagesHaveNoGapsOrRepeats(t *testing.T) {
	a := newApp(t)
	a.signUp()
	ts := time.Now().Unix() - 3600
	const total = 2*pageSize + 7
	for i := range total {
		a.db.Exec(`INSERT INTO videos (id, channel_id, title, published_at) VALUES (?, ?, ?, ?)`,
			fmt.Sprintf("tie%08d", i), chanA, fmt.Sprintf("Tie %d", i), ts)
	}
	reMore := regexp.MustCompile(`id="more" class="more button" href="([^"]+)"`)
	reID := regexp.MustCompile(`/watch/(tie\d{8})`)
	for _, sort := range []string{"newest", "oldest"} {
		a.post("/account/preferences", url.Values{"sort": {sort}})
		seen := map[string]int{}
		path := "/?fragment=1"
		for range 10 {
			_, body := a.get(path)
			onPage := map[string]bool{}
			for _, m := range reID.FindAllStringSubmatch(body, -1) {
				onPage[m[1]] = true
			}
			for id := range onPage {
				seen[id]++
			}
			m := reMore.FindStringSubmatch(body)
			if m == nil {
				break
			}
			path = "/" + html.UnescapeString(m[1]) + "&fragment=1"
		}
		if len(seen) != total {
			t.Errorf("%s first: saw %d of %d videos", sort, len(seen), total)
		}
		for id, n := range seen {
			if n > 1 {
				t.Errorf("%s first: %s shown on %d pages", sort, id, n)
			}
		}
	}
}

// Importing the same file twice adds nothing, keeps real channel names and
// does not duplicate lists.
func TestImportIsIdempotentAndKeepsTitles(t *testing.T) {
	a := newApp(t)
	a.signUp()
	opml := `<?xml version="1.0"?><opml version="2.0"><body>
		<outline text="Music"><outline text="" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=` + chanA + `"/></outline>
	</body></opml>`
	for i := range 2 {
		_, body := a.upload("/channels/import", nil, map[string][]byte{"file": []byte(opml)})
		if i == 1 && !strings.Contains(body, "Imported 0 new of 1 channels") {
			t.Errorf("second import did not report 0 new")
		}
	}
	if n := a.count(`SELECT count(*) FROM lists`); n != 1 {
		t.Errorf("two imports created %d lists, want 1", n)
	}
	var title string
	a.db.QueryRow(`SELECT title FROM channels WHERE id = ?`, chanA).Scan(&title)
	if title != "Chan A" {
		t.Errorf("import without a name overwrote the channel title with %q", title)
	}
}

// TubeShelf's own export lists a channel at the top and again in each of its
// lists; importing it back counts each channel once.
func TestExportReimportCountsChannelsOnce(t *testing.T) {
	a := newApp(t)
	a.signUp()
	opml := `<?xml version="1.0"?><opml version="2.0"><body>
		<outline text="Music"><outline text="A" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=` + chanA + `"/></outline>
	</body></opml>`
	a.upload("/channels/import", nil, map[string][]byte{"file": []byte(opml)})
	_, export := a.get("/channels/export.opml")
	if strings.Count(export, chanA) != 2 {
		t.Fatalf("export should list the channel at the top and in its list:\n%s", export)
	}
	if _, body := a.upload("/channels/import", nil, map[string][]byte{"file": []byte(export)}); !strings.Contains(body, "Imported 0 new of 1 channels") {
		t.Error("re-importing the export did not count the channel once")
	}
}

// Day headings count calendar days, also across a daylight saving change.
func TestDayLabelAcrossDST(t *testing.T) {
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Skip("no tz database:", err)
	}
	// Clocks went forward on 29 March 2026: that day had 23 hours.
	now := time.Date(2026, 3, 30, 10, 0, 0, 0, loc)
	if got := dayLabel(time.Date(2026, 3, 29, 12, 0, 0, 0, loc).Unix(), now); got != "Yesterday" {
		t.Errorf("29 March seen on 30 March = %q, want Yesterday", got)
	}
	if got := dayLabel(time.Date(2026, 3, 23, 12, 0, 0, 0, loc).Unix(), now); got != "23 March" {
		t.Errorf("a week before = %q, want 23 March", got)
	}
}

// Redirects after a form only go back to this site.
func TestBackIgnoresForeignReferer(t *testing.T) {
	a := newApp(t)
	a.signUp()
	a.c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	req, _ := http.NewRequest(http.MethodPost, a.url+"/account/profile", strings.NewReader("name=x"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Referer", "https://evil.example/phish")
	res, err := a.c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if loc := res.Header.Get("Location"); strings.Contains(loc, "evil.example") || !strings.HasPrefix(loc, "/") {
		t.Errorf("redirect after form goes to %q", loc)
	}
}

// Comments come through the server: HTML-escaped, cached, and a failure at
// YouTube shows a message instead of breaking the watch page.
func TestComments(t *testing.T) {
	a := newApp(t)
	a.signUp()
	if _, body := a.get("/watch/video000001"); !strings.Contains(body, `data-comments="/videos/video000001/comments"`) {
		t.Fatal("watch page has no comments section")
	}
	if code, body := a.get("/videos/video000001/comments"); code != http.StatusBadGateway || !strings.Contains(body, "could not be loaded") {
		t.Errorf("YouTube unreachable: %d %q", code, body)
	}

	calls := 0
	yt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		b, _ := io.ReadAll(r.Body)
		if strings.Contains(string(b), `"videoId"`) {
			io.WriteString(w, `{"contents":{"twoColumnWatchNextResults":{"results":{"results":{"contents":[{"itemSectionRenderer":{"targetId":"comments-section","contents":[{"continuationItemRenderer":{"continuationEndpoint":{"continuationCommand":{"token":"FIRST"}}}}]}}]}}}}}`)
			return
		}
		io.WriteString(w, `{"onResponseReceivedEndpoints":[{"appendContinuationItemsAction":{"continuationItems":[
			{"sortFilterSubMenuRenderer":{"subMenuItems":[{"title":"Top","serviceEndpoint":{"continuationCommand":{"token":"TOP"}}},{"title":"Newest first","serviceEndpoint":{"continuationCommand":{"token":"NEW"}}}]}},
			{"commentThreadRenderer":{"comment":{"commentRenderer":{"commentId":"c1","authorText":{"simpleText":"@mallory"},"contentText":{"simpleText":"<script>alert(1)</script>"}}}}},
			{"continuationItemRenderer":{"continuationEndpoint":{"continuationCommand":{"token":"MORE"}}}}]}}]}`)
	}))
	defer yt.Close()
	a.yt.BaseURL = yt.URL
	a.db.Exec(`DELETE FROM videos WHERE id = 'video000002'`) // nothing cached for this id yet
	code, body := a.get("/videos/video000002/comments")
	if code != http.StatusOK || !strings.Contains(body, "@mallory") || !strings.Contains(body, `data-comments-more="MORE"`) || !strings.Contains(body, `data-comments-sort="NEW"`) {
		t.Fatalf("comments: %d %s", code, body)
	}
	if strings.Contains(body, "<script>") {
		t.Error("comment text is not escaped")
	}
	before := calls
	a.get("/videos/video000002/comments")
	if calls != before {
		t.Error("the same page was fetched from YouTube again instead of the cache")
	}
	if _, body := a.get("/videos/video000002/comments?t=MORE"); strings.Contains(body, "data-comments-sort") {
		t.Error("a 'more' page repeats the sort buttons")
	}
	if code, _ := a.get("/videos/bad/comments"); code != http.StatusNotFound {
		t.Errorf("invalid id: status %d", code)
	}
	anon := &app{t: t, db: a.db, url: a.url, c: &http.Client{}}
	if _, body := anon.get("/videos/video000002/comments"); strings.Contains(body, "@mallory") {
		t.Error("comments are served to signed-out visitors")
	}
}

// Round-4 usability fixes: sign-in returns to the page asked for, non-admins get
// a real page instead of bare text, and saving preferences says so.
func TestSignInFlowAndForbiddenPage(t *testing.T) {
	a := newApp(t)
	a.signUp()
	auth.CreateUser(a.db, "kid@example.com", "Kid", "correct horse", false)

	jar, _ := cookiejar.New(nil)
	anon := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := anon.Get(a.url + "/later?x=1")
	if err != nil {
		t.Fatal(err)
	}
	if loc := res.Header.Get("Location"); loc != "/login?next="+url.QueryEscape("/later?x=1") {
		t.Errorf("redirect to %q", loc)
	}
	for next, want := range map[string]string{"/later?x=1": "/later?x=1", "//evil.example/": "/", "https://evil.example/": "/", `/\evil.example`: "/"} {
		req, _ := http.NewRequest(http.MethodPost, a.url+"/login", strings.NewReader(url.Values{"email": {"kid@example.com"}, "password": {"correct horse"}, "next": {next}}.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		res, err := anon.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if loc := res.Header.Get("Location"); loc != want {
			t.Errorf("next=%q: redirect to %q, want %q", next, loc, want)
		}
	}

	kid := a.as("kid@example.com", "correct horse")
	code, body := kid.get("/admin/users")
	if code != http.StatusForbidden || !strings.Contains(body, "Back to your feed") || !strings.Contains(body, "<nav") {
		t.Errorf("forbidden page: %d %.200q", code, body)
	}
	if code, _ := kid.post("/admin/users", url.Values{"email": {"x@example.com"}}); code != http.StatusForbidden {
		t.Errorf("admin POST by non-admin: %d", code)
	}

	req, _ := http.NewRequest(http.MethodPost, a.url+"/account/preferences", strings.NewReader("theme=dark"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Referer", a.url+"/account/preferences")
	res, err = (&http.Client{Jar: a.c.Jar, CheckRedirect: anon.CheckRedirect}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if loc := res.Header.Get("Location"); !strings.Contains(loc, "msg=Preferences+saved") {
		t.Errorf("preferences redirect %q has no message", loc)
	}
}
