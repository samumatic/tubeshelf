package web

import (
	"bytes"
	"database/sql"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/samumatic/tubeshelf/internal/auth"
	"github.com/samumatic/tubeshelf/internal/db"
	"github.com/samumatic/tubeshelf/internal/fetch"
	"github.com/samumatic/tubeshelf/internal/yt"
)

const chanA = "UCaaaaaaaaaaaaaaaaaaaaaa"

type app struct {
	t   *testing.T
	db  *sql.DB
	url string
	c   *http.Client
}

func newApp(t *testing.T) *app {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	client := yt.New()
	client.BaseURL = "http://127.0.0.1:1" // tests must never reach YouTube
	secret, _ := auth.LoadSecret(dir)
	s := &Server{DB: d, YT: client, Fetcher: fetch.New(d, client), Secret: secret, DataDir: dir, Version: "test"}
	h, err := s.Handler()
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(func() { srv.Close(); d.Close() })
	jar, _ := cookiejar.New(nil)
	return &app{t: t, db: d, url: srv.URL, c: &http.Client{Jar: jar}}
}

func (a *app) get(path string) (int, string) {
	a.t.Helper()
	res, err := a.c.Get(a.url + path)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(body)
}

// post submits a form the way app.js does and returns the status and body.
func (a *app) post(path string, form url.Values, headers ...string) (int, string) {
	a.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, a.url+path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-Requested-With", "fetch")
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := a.c.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(body)
}

// signUp runs first-run setup and seeds one channel with videos.
func (a *app) signUp() {
	a.t.Helper()
	if code, _ := a.post("/setup", url.Values{"email": {"admin@example.com"}, "password": {"correct horse"}}); code != http.StatusOK {
		a.t.Fatalf("setup: status %d", code)
	}
	now := time.Now().Unix()
	a.db.Exec(`INSERT INTO channels (id, title) VALUES (?, 'Chan A')`, chanA)
	a.db.Exec(`INSERT INTO subscriptions (user_id, channel_id, added_at) SELECT id, ?, 0 FROM users`, chanA)
	a.db.Exec(`INSERT INTO videos (id, channel_id, title, published_at, kind, duration_seconds) VALUES
		('video000001', ?, 'Regular <video>', ?, 'video', 600),
		('short000001', ?, 'A short one', ?, 'short', 30),
		('older000001', ?, 'Older video', ?, 'video', 100)`, chanA, now-60, chanA, now-120, chanA, now-180)
}

func TestSetupAndFeed(t *testing.T) {
	a := newApp(t)
	if _, body := a.get("/"); !strings.Contains(body, "This account becomes the administrator") {
		t.Fatal("fresh instance does not lead to setup")
	}
	a.signUp()
	if code, _ := a.get("/setup"); code != http.StatusOK {
		t.Errorf("setup after setup: status %d", code)
	}
	if _, body := a.get("/setup"); strings.Contains(body, "This account becomes the administrator") {
		t.Error("setup is still reachable once a user exists")
	}

	_, body := a.get("/")
	if !strings.Contains(body, "Regular &lt;video&gt;") {
		t.Error("feed misses the video, or the title is not escaped")
	}
	if strings.Contains(body, "A short one") {
		t.Error("Shorts are shown although hide_shorts defaults to on")
	}
	if strings.Index(body, "Regular") > strings.Index(body, "Older video") {
		t.Error("feed is not newest first")
	}

	// Showing Shorts and searching.
	a.post("/account/preferences", url.Values{"hide_shorts": {"0"}})
	if _, body := a.get("/"); !strings.Contains(body, "A short one") {
		t.Error("Shorts still hidden after turning the filter off")
	}
	if _, body := a.get("/?q=older"); strings.Contains(body, "Regular") || !strings.Contains(body, "Older video") {
		t.Error("search does not filter by title")
	}
	if _, body := a.get("/?q=100%25"); strings.Contains(body, "Older video") {
		t.Error("% in a search acts as a wildcard")
	}
}

func TestWatchedLaterAndProgress(t *testing.T) {
	a := newApp(t)
	a.signUp()
	count := func(q string) (n int) { a.db.QueryRow(q).Scan(&n); return }

	if code, _ := a.post("/videos/video000001/later", url.Values{"on": {"1"}}); code != http.StatusNoContent {
		t.Fatalf("later: status %d", code)
	}
	if _, body := a.get("/later"); !strings.Contains(body, "Regular") {
		t.Error("saved video missing from Later")
	}

	// 50% does not count as watched at the default 90% threshold, 95% does.
	_, body := a.post("/videos/video000001/progress", url.Values{"t": {"300"}, "d": {"600"}})
	if !strings.Contains(body, `"watched":false`) {
		t.Errorf("progress 50%%: %s", body)
	}
	_, body = a.post("/videos/video000001/progress", url.Values{"t": {"570"}, "d": {"600"}})
	if !strings.Contains(body, `"watched":true`) {
		t.Errorf("progress 95%%: %s", body)
	}
	// Rewinding must not unmark it.
	a.post("/videos/video000001/progress", url.Values{"t": {"10"}, "d": {"600"}})
	if count(`SELECT watched FROM watch_state WHERE video_id = 'video000001'`) != 1 {
		t.Error("rewinding cleared the watched mark")
	}

	a.post("/account/preferences", url.Values{"hide_watched": {"1"}})
	if _, body := a.get("/"); strings.Contains(body, "Regular") {
		t.Error("watched video shown although hide_watched is on")
	}
	a.post("/videos/video000001/watched", url.Values{"on": {"0"}})
	if count(`SELECT watched + progress FROM watch_state WHERE video_id = 'video000001'`) != 0 {
		t.Error("unmarking did not clear watched and progress")
	}
	if code, _ := a.post("/videos/not-an-id!/watched", url.Values{"on": {"1"}}); code != http.StatusNotFound {
		t.Errorf("invalid video id: status %d", code)
	}
}

func TestAccessControl(t *testing.T) {
	a := newApp(t)
	a.signUp()
	auth.CreateUser(a.db, "user@example.com", "", "correct horse", false)

	// A cross-site POST carrying the session cookie is refused (CSRF).
	if code, _ := a.post("/videos/video000001/watched", url.Values{"on": {"1"}}, "Sec-Fetch-Site", "cross-site"); code != http.StatusForbidden {
		t.Errorf("cross-site POST: status %d, want 403", code)
	}

	anon := &app{t: t, db: a.db, url: a.url, c: &http.Client{}}
	if code, _ := anon.post("/videos/video000001/watched", url.Values{"on": {"1"}}); code != http.StatusUnauthorized {
		t.Errorf("anonymous POST: status %d, want 401", code)
	}
	if _, body := anon.get("/admin"); !strings.Contains(body, "Sign in") {
		t.Error("anonymous /admin does not lead to the login page")
	}

	jar, _ := cookiejar.New(nil)
	user := &app{t: t, db: a.db, url: a.url, c: &http.Client{Jar: jar}}
	if code, _ := user.post("/login", url.Values{"email": {"user@example.com"}, "password": {"correct horse"}}); code != http.StatusOK {
		t.Fatalf("login: status %d", code)
	}
	for _, p := range []string{"/admin", "/admin/users", "/admin/sign-in", "/admin/instance"} {
		if code, _ := user.get(p); code != http.StatusForbidden {
			t.Errorf("non-admin %s: status %d, want 403", p, code)
		}
	}
	if code, _ := user.upload("/admin/appearance", map[string]string{"app_name": "x", "layout": "plain", "radius": "1"}, nil); code != http.StatusForbidden {
		t.Errorf("non-admin POST /admin/appearance: status %d, want 403", code)
	}
	if code, _ := user.post("/admin/settings", url.Values{"retention_days": {"7"}}); code != http.StatusForbidden {
		t.Errorf("non-admin POST /admin/settings: status %d, want 403", code)
	}
	// Another user's feed stays empty: subscriptions are per user.
	if _, body := user.get("/"); strings.Contains(body, "Regular") {
		t.Error("user sees videos of a channel only the admin subscribed to")
	}
}

func TestAPIKey(t *testing.T) {
	a := newApp(t)
	a.signUp()
	var uid string
	a.db.QueryRow(`SELECT id FROM users`).Scan(&uid)
	key, _ := auth.NewAPIKey(a.db, uid, "script")

	call := func(key string) (int, string) {
		req, _ := http.NewRequest(http.MethodGet, a.url+"/api/subscriptions", nil)
		req.Header.Set("X-API-Key", key)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(body)
	}
	if code, body := call(key); code != http.StatusOK || !strings.Contains(body, chanA) {
		t.Errorf("valid key: %d %s", code, body)
	}
	if code, _ := call("tsk_nope"); code != http.StatusUnauthorized {
		t.Errorf("invalid key: status %d", code)
	}
	// A key does not open the HTML pages.
	req, _ := http.NewRequest(http.MethodGet, a.url+"/account", nil)
	req.Header.Set("X-API-Key", key)
	res, _ := (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if res.StatusCode != http.StatusSeeOther {
		t.Errorf("API key on /account: status %d, want redirect to login", res.StatusCode)
	}
}

func TestParseImport(t *testing.T) {
	opmlFile := `<?xml version="1.0"?><opml version="2.0"><body>
		<outline text="YouTube Subscriptions"><outline text="Chan A" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa"/></outline>
		<outline text="Tech"><outline title="Chan B" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UCbbbbbbbbbbbbbbbbbbbbbb"/></outline>
	</body></opml>`
	got, err := parseImport([]byte(opmlFile))
	if err != nil || len(got) != 2 {
		t.Fatalf("opml: %+v, %v", got, err)
	}
	if got[0].List != "" || got[0].Title != "Chan A" {
		t.Errorf("wrapper folder became a list: %+v", got[0])
	}
	if got[1].List != "Tech" || got[1].ID != "UCbbbbbbbbbbbbbbbbbbbbbb" || got[1].Title != "Chan B" {
		t.Errorf("folder not read as list: %+v", got[1])
	}

	csvFile := "Channel Id,Channel Url,Channel Title\nUCaaaaaaaaaaaaaaaaaaaaaa,http://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa,\"A, with comma\"\n"
	got, err = parseImport([]byte("\xef\xbb\xbf" + csvFile))
	if err != nil || len(got) != 1 || got[0].Title != "A, with comma" {
		t.Errorf("takeout csv: %+v, %v", got, err)
	}

	got, err = parseImport([]byte("https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa\n\n@handle\n"))
	if err != nil || len(got) != 2 || got[0].ID == "" || got[1].Ref != "@handle" {
		t.Errorf("plain list: %+v, %v", got, err)
	}
	if _, err := parseImport([]byte("<opml><body></body></opml>")); err == nil {
		t.Error("empty OPML accepted")
	}
}

func TestOPMLRoundTrip(t *testing.T) {
	a := newApp(t)
	a.signUp()
	a.db.Exec(`INSERT INTO lists (user_id, name) SELECT id, 'Tech' FROM users`)
	a.db.Exec(`INSERT INTO list_channels (list_id, channel_id) SELECT id, ? FROM lists`, chanA)
	_, body := a.get("/channels/export.opml")
	got, err := parseImport([]byte(body))
	if err != nil || len(got) != 2 {
		t.Fatalf("export does not re-import: %+v, %v\n%s", got, err, body)
	}
	if got[0].ID != chanA || got[0].List != "" || got[1].List != "Tech" {
		t.Errorf("round trip lost data: %+v", got)
	}
}

// Every page renders completely: a template error would only be logged and
// leave a cut-off page with status 200.
func TestPagesRender(t *testing.T) {
	a := newApp(t)
	a.signUp()
	pages := map[string]string{
		"/": "Feed", "/later": "Watch later", "/history": "History", "/library": "Library",
		"/channels": "Channels", "/lists": "Lists", "/channels/import": "Import &amp; export",
		"/account": "My account", "/account/preferences": "Preferences", "/account/keys": "API keys",
		"/admin": "Status", "/admin/users": "Users", "/admin/sign-in": "Sign-in", "/admin/instance": "Instance",
		"/admin/appearance": "Appearance",
	}
	for path, title := range pages {
		code, body := a.get(path)
		if code != http.StatusOK || !strings.Contains(body, `<h1 class="page-title">`+title) || !strings.Contains(body, "</html>") {
			t.Errorf("%s: status %d, title %q or end of page missing", path, code, title)
		}
	}
	if _, body := a.get("/settings"); !strings.Contains(body, `<h1 class="page-title">Preferences`) {
		t.Error("/settings does not lead to the preferences page")
	}
}

// The sign-in and instance forms each send only their own fields; saving
// one must not reset the other's.
func TestInstanceSettingsPartial(t *testing.T) {
	a := newApp(t)
	a.signUp()
	a.post("/admin/settings", url.Values{"public_registration": {"0", "1"}})
	a.post("/admin/settings", url.Values{"retention_days": {"30"}})
	if v := db.Setting(a.db, "public_registration"); v != "1" {
		t.Errorf("public_registration = %q after saving the instance form, want 1", v)
	}
	if v := db.Setting(a.db, "retention_days"); v != "30" {
		t.Errorf("retention_days = %q, want 30", v)
	}
	a.post("/admin/settings", url.Values{"public_registration": {"0"}})
	if v := db.Setting(a.db, "public_registration"); v != "0" {
		t.Errorf("public_registration = %q after switching it off, want 0", v)
	}
}

// upload posts a multipart form the way a browser does (no fetch header).
func (a *app) upload(path string, fields map[string]string, files map[string][]byte) (int, string) {
	a.t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for k, v := range fields {
		mw.WriteField(k, v)
	}
	for k, data := range files {
		fw, _ := mw.CreateFormFile(k, k+".bin")
		fw.Write(data)
	}
	mw.Close()
	req, _ := http.NewRequest(http.MethodPost, a.url+path, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	res, err := a.c.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestGroupDays(t *testing.T) {
	a := newApp(t)
	a.signUp()
	if _, body := a.get("/"); !strings.Contains(body, `<h2 class="day">`) {
		t.Fatal("day headings missing by default")
	}
	a.post("/account/preferences", url.Values{"group_days": {"0"}})
	if _, body := a.get("/"); strings.Contains(body, `<h2 class="day">`) || !strings.Contains(body, `class="videos"`) {
		t.Fatal("feed still grouped by day")
	}
}

func TestSidebarWidth(t *testing.T) {
	a := newApp(t)
	a.signUp()
	if _, body := a.get("/"); !strings.Contains(body, `class="sw-256"`) {
		t.Fatal("default width class missing")
	}
	a.post("/account/preferences", url.Values{"sidebar_width": {"304"}})
	a.post("/account/preferences", url.Values{"sidebar_width": {"300"}}) // not a 16px step: ignored
	a.post("/account/preferences", url.Values{"sidebar": {"collapsed"}})
	if _, body := a.get("/"); !strings.Contains(body, `class="rail sw-304"`) || !strings.Contains(body, `aria-valuenow="304"`) {
		t.Fatalf("width not kept: %.400s", body)
	}
}

func TestAppearance(t *testing.T) {
	a := newApp(t)
	a.signUp()
	var pngData bytes.Buffer
	png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	fields := map[string]string{"app_name": "MyTube", "layout": "plain", "primary": "custom", "primary_custom": "#E5484D", "radius": "0.5"}

	_, body := a.upload("/admin/appearance", fields, map[string][]byte{"logo": pngData.Bytes()})
	if !strings.Contains(body, "Appearance saved") {
		t.Fatalf("save did not succeed: %.300s", body)
	}
	_, body = a.get("/")
	if !strings.Contains(body, "<title>MyTube</title>") && !strings.Contains(body, "MyTube</a>") {
		t.Error("the application name is not used")
	}
	if strings.Contains(body, `class="backdrop"`) {
		t.Error("plain layout still renders the backdrop photo")
	}
	if !strings.Contains(body, `<img src="/branding/logo?v=`) {
		t.Error("uploaded logo is not shown")
	}
	_, css := a.get("/branding/theme.css")
	if !strings.Contains(css, "--primary: #e5484d") || !strings.Contains(css, "--primary-fg: #000000") || !strings.Contains(css, "--radius-md: 6px") {
		t.Errorf("theme.css misses the saved values: %s", css)
	}

	// The logo is public, for the sign-in page.
	anon := &app{t: t, db: a.db, url: a.url, c: &http.Client{}}
	res, err := http.Get(a.url + "/branding/logo")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "image/png" {
		t.Errorf("logo: status %d, type %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
	if _, body := anon.get("/login"); !strings.Contains(body, "Sign in to MyTube") || !strings.Contains(body, `class="auth-bg"`) {
		t.Error("sign-in page misses the name or the background")
	}

	// Not an image: rejected, nothing stored.
	_, body = a.upload("/admin/appearance", fields, map[string][]byte{"background": []byte("<html>not an image</html>")})
	if !strings.Contains(body, "use a PNG, JPEG, WebP or GIF image") || db.Setting(a.db, "background_v") != "" {
		t.Error("a non-image background was accepted")
	}

	// Reset goes back to the built-in logo.
	a.post("/admin/appearance/reset", url.Values{"kind": {"logo"}})
	if code, _ := anon.get("/branding/logo"); code != http.StatusNotFound {
		t.Errorf("logo after reset: status %d, want 404", code)
	}
}

func TestThemeCSS(t *testing.T) {
	if css := themeCSS("", "1.25"); strings.Contains(css, "--primary") || !strings.Contains(css, "--radius-3xl: 30px") {
		t.Errorf("default theme: %s", css)
	}
	if css := themeCSS("#ffc53d", "1"); !strings.Contains(css, "--primary-fg: #000000") {
		t.Errorf("light primary needs dark text: %s", css)
	}
	if css := themeCSS("#3e63dd", "1"); !strings.Contains(css, "--primary-fg: #ffffff") {
		t.Errorf("dark primary needs light text: %s", css)
	}
	if css := themeCSS("red;}", "1"); strings.Contains(css, "red") {
		t.Errorf("invalid color leaked into the stylesheet: %s", css)
	}
}
