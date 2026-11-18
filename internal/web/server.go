// Package web serves the HTML UI, the small JSON API and cached media.
package web

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/samumatic/tubeshelf/internal/auth"
	"github.com/samumatic/tubeshelf/internal/db"
	"github.com/samumatic/tubeshelf/internal/fetch"
	"github.com/samumatic/tubeshelf/internal/yt"
)

//go:embed templates/*.html
var templateFS embed.FS

//go:embed static
var staticFS embed.FS

const sessionCookie = "tubeshelf_session"

type Server struct {
	DB      *sql.DB
	YT      *yt.Client
	Fetcher *fetch.Fetcher
	Secret  auth.Secret
	DataDir string
	Version string

	pages         map[string]*template.Template
	assetVer      string
	logins        limiter
	segments      segmentCache
	commentsCache commentCache
	media         *http.Client
}

type ctxKey struct{}

func (s *Server) user(r *http.Request) *auth.User {
	u, _ := r.Context().Value(ctxKey{}).(*auth.User)
	return u
}

// Handler builds the routes. Call once.
func (s *Server) Handler() (http.Handler, error) {
	if err := s.loadTemplates(); err != nil {
		return nil, err
	}
	s.media = &http.Client{Timeout: 15 * time.Second}
	static, _ := fs.Sub(staticFS, "static")
	s.assetVer = hashFS(static)

	mux := http.NewServeMux()
	// Public.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.Handle("GET /static/", http.StripPrefix("/static/", cacheForever(http.FileServerFS(static))))
	mux.HandleFunc("GET /login", s.loginPage)
	mux.HandleFunc("POST /login", s.loginSubmit)
	mux.HandleFunc("GET /setup", s.setupPage)
	mux.HandleFunc("POST /setup", s.setupSubmit)
	mux.HandleFunc("GET /register", s.registerPage)
	mux.HandleFunc("POST /register", s.registerSubmit)
	mux.HandleFunc("GET /welcome", s.welcomePage)
	mux.HandleFunc("POST /welcome", s.welcomeSubmit)
	mux.HandleFunc("GET /api/auth/oidc/start", s.oidcStart)
	mux.HandleFunc("GET /branding/theme.css", s.themeStylesheet)
	mux.HandleFunc("GET /speculation-rules.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/speculationrules+json")
		io.WriteString(w, speculationRules)
	})
	mux.HandleFunc("GET /branding/{kind}", s.brandImage)
	mux.HandleFunc("GET "+auth.CallbackPath, s.oidcCallback)
	mux.HandleFunc("GET /", s.notFound)

	// Signed-in pages.
	page := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, s.requireUser(h)) }
	page("GET /{$}", s.feedPage)
	page("GET /later", s.laterPage)
	page("GET /history", s.historyPage)
	page("GET /watch/{id}", s.watchPage)
	page("POST /videos/{id}/watched", s.setWatched)
	page("POST /videos/{id}/later", s.setLater)
	page("POST /later/clear-watched", s.clearWatchedLater)
	page("POST /history/{id}/remove", s.forget)
	page("POST /history/clear", s.clearHistory)
	page("POST /videos/{id}/progress", s.setProgress)
	page("GET /videos/{id}/segments", s.sponsorSegments)
	page("GET /videos/{id}/comments", s.comments)
	page("GET /thumb/{id}", s.thumb)
	page("GET /avatar/{id}", s.avatar)
	page("POST /logout", s.logout)

	page("GET /library", s.libraryPage)
	page("GET /channels", s.channelsPage)
	page("GET /channels/import", s.importPage)
	page("GET /lists", s.listsPage)
	page("POST /channels", s.addChannel)
	page("POST /channels/import", s.importOPML)
	page("GET /channels/export.opml", s.exportOPML)
	page("POST /channels/{id}/delete", s.deleteChannel)
	page("POST /channels/{id}/scrape", s.scrapeChannel)
	page("POST /lists", s.addList)
	page("POST /lists/{id}/delete", s.deleteList)
	page("POST /lists/{id}", s.updateList)
	page("POST /lists/{id}/channels", s.setListChannel)

	page("GET /account", s.accountPage)
	page("GET /account/preferences", s.preferencesPage)
	page("GET /account/keys", s.keysPage)
	page("POST /account/preferences", s.saveSettings)
	page("POST /account/profile", s.saveProfile)
	page("POST /account/password", s.changePassword)
	page("POST /account/keys", s.addAPIKey)
	page("POST /account/keys/{id}/delete", s.deleteAPIKey)
	page("POST /account/danger", s.danger)
	page("POST /account/unlink", s.unlinkSSO)
	// The preferences page lived here before the account pages; keeps bookmarks working.
	mux.Handle("GET /settings", http.RedirectHandler("/account/preferences", http.StatusMovedPermanently))

	admin := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, s.requireUser(s.requireAdmin(h))) }
	admin("GET /admin", s.adminStatusPage)
	admin("GET /admin/users", s.adminUsersPage)
	admin("GET /admin/sign-in", s.adminSignInPage)
	admin("GET /admin/instance", s.adminInstancePage)
	admin("GET /admin/appearance", s.adminAppearancePage)
	admin("POST /admin/appearance", s.saveAppearance)
	admin("POST /admin/appearance/reset", s.resetBrandImage)
	admin("POST /admin/settings", s.saveInstanceSettings)
	admin("POST /admin/refresh", s.refreshAll)
	admin("POST /admin/checklist/hide", s.hideChecklist)
	admin("POST /admin/channels/{id}/retry", s.retryChannel)
	admin("POST /admin/channels/{id}/remove", s.removeChannel)
	admin("POST /admin/defaults", s.saveUserDefaults)
	admin("POST /admin/danger", s.instanceDanger)
	admin("POST /admin/users", s.adminAddUser)
	admin("POST /admin/users/{id}", s.adminUpdateUser)
	admin("POST /admin/providers", s.adminSaveProvider)
	admin("POST /admin/providers/{id}/delete", s.adminDeleteProvider)

	// JSON API, usable with an API key.
	api := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, s.requireAPI(h)) }
	api("GET /api/subscriptions", s.apiListSubscriptions)
	api("POST /api/subscriptions", s.apiAddSubscription)
	api("DELETE /api/subscriptions/{id}", s.apiDeleteSubscription)
	api("DELETE /api/subscriptions", s.apiDeleteSubscription)
	api("GET /api/subscriptions/export", s.exportOPML)
	api("GET /api/videos", s.apiVideos)
	// Anything else under /api/ answers in JSON too, with Allow for a known path and a wrong method.
	apiMethods := map[string]string{"/api/subscriptions": "GET, POST, DELETE", "/api/subscriptions/export": "GET", "/api/videos": "GET", "/api/version": "GET"}
	apiFallback := func(w http.ResponseWriter, r *http.Request) {
		allow := apiMethods[r.URL.Path]
		if allow == "" && strings.HasPrefix(r.URL.Path, "/api/subscriptions/") {
			allow = "DELETE"
		}
		if allow != "" {
			w.Header().Set("Allow", allow)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": r.Method + " is not supported here; use " + allow})
			return
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such API endpoint; see the README for the list"})
	}
	for _, m := range []string{"GET", "POST", "PUT", "PATCH", "DELETE"} {
		mux.HandleFunc(m+" /api/", apiFallback)
	}
	mux.HandleFunc("GET /api/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"version": s.Version})
	})

	// Rejects cross-site POSTs (CSRF) using Sec-Fetch-Site / Origin.
	csrf := http.NewCrossOriginProtection()
	return compress(securityHeaders(csrf.Handler(s.loadUser(mux)))), nil
}

func (s *Server) loadTemplates() error {
	funcs := template.FuncMap{
		"ago": ago, "dur": dur, "iso": func(t int64) string { return time.Unix(t, 0).UTC().Format(time.RFC3339) },
		"date": func(t int64) string { return time.Unix(t, 0).Format("2 Jan 2006") },
		"pct":  pct, "query": queryWith, "initial": initial,
		// ctx is the query a watch link carries, so the watch page's Up next continues where the video was found.
		"card": func(v Video, set map[string]string, ctx ...string) M {
			return M{"V": v, "Set": set, "Ctx": strings.Join(ctx, "")}
		},
		"toggle": func(key, label string, set map[string]string) M {
			return M{"Key": key, "Label": label, "On": set[key] == "1"}
		},
		"list":        func(items ...string) []string { return items },
		"split":       strings.Split,
		"hasPrefix":   strings.HasPrefix,
		"inc":         func(i int) int { return i + 1 },
		"linkify":     linkify,
		"newProvider": func() auth.Provider { return auth.Provider{} },
	}
	base, err := template.New("base").Funcs(funcs).ParseFS(templateFS, "templates/_*.html")
	if err != nil {
		return err
	}
	names, _ := fs.Glob(templateFS, "templates/[a-z]*.html")
	s.pages = map[string]*template.Template{}
	for _, n := range names {
		t, err := template.Must(base.Clone()).ParseFS(templateFS, n)
		if err != nil {
			return err
		}
		s.pages[strings.TrimSuffix(strings.TrimPrefix(n, "templates/"), ".html")] = t
	}
	return nil
}

type M = map[string]any

// render executes a page inside the layout. Fragment requests (infinite
// scroll) get only the "items" block.
// speculationRules let Chromium prerender a page while the pointer rests on its link (about 200ms), so a
// click shows the finished page, thumbnails included, and the page fade runs on it as in Pocket ID.
// Only pages without side effects: the player is left out, it would contact YouTube before play.
const speculationRules = `{"prerender": [{"eagerness": "moderate", "where": {"href_matches": [
  "/", "/later", "/history", "/library", "/channels", "/channels/import", "/lists",
  "/account", "/account/preferences", "/account/keys", "/account/profile", "/account/password", "/account/danger",
  "/admin", "/admin/users", "/admin/sign-in", "/admin/instance", "/admin/appearance"]}}]}`

func (s *Server) render(w http.ResponseWriter, r *http.Request, page string, data M) {
	if data == nil {
		data = M{}
	}
	u := s.user(r)
	data["User"] = u
	if u != nil {
		data["NavLists"] = s.lists(u.ID)
	}
	data["Brand"] = s.brand()
	data["Page"] = page
	data["AssetV"] = s.assetVer
	data["Version"] = s.Version
	data["Release"], _, _ = strings.Cut(s.Version, "+") // without the build hash, for the sidebar
	// Messages in the URL show only when this server wrote them: a crafted link cannot put text on the page.
	fq := r.URL.Query()
	if !flashValid(fq) {
		for _, k := range []string{"msg", "err", "go", "golabel"} {
			fq.Del(k)
		}
	}
	data["Msg"] = fq.Get("msg")
	if e := fq.Get("err"); e != "" || data["Err"] == nil {
		data["Err"] = sentence(e)
	}
	// A message can offer the obvious next step ("Subscribed to X · Open the feed").
	if goURL := fq.Get("go"); goURL != "" && localPath(goURL) == goURL {
		data["Go"] = M{"URL": goURL, "Label": fq.Get("golabel")}
	}
	if u != nil && u.IsAdmin {
		var failing int
		s.DB.QueryRow(`SELECT count(*) FROM channels WHERE fail_count > 2`).Scan(&failing)
		data["AdminAlert"] = failing
	}
	if _, ok := data["Set"]; !ok {
		if u != nil {
			data["Set"] = db.UserSettings(s.DB, u.ID)
		} else {
			data["Set"] = db.EffectiveDefaults(s.DB)
		}
	}
	block := "layout"
	if r.URL.Query().Get("fragment") == "1" {
		block = "items"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// no-cache, not no-store: the browser may keep the page for Back (bfcache) but asks again on a normal visit.
	w.Header().Set("Cache-Control", "private, no-cache")
	if u != nil && block == "layout" {
		w.Header().Set("Speculation-Rules", `"/speculation-rules.json"`)
	}
	if err := s.pages[page].ExecuteTemplate(w, block, data); err != nil {
		slog.Error("render", "page", page, "err", err)
	}
}

func hashFS(f fs.FS) string {
	h := sha256.New()
	fs.WalkDir(f, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := fs.ReadFile(f, p)
			h.Write([]byte(p))
			h.Write(b)
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:10]
}

func cacheForever(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Asset URLs carry ?v=<content hash>, so they can be cached for good.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		h.ServeHTTP(w, r)
	})
}

func securityHeaders(h http.Handler) http.Handler {
	const csp = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
		"frame-src https://www.youtube-nocookie.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.ServeHTTP(w, r)
	})
}

func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" || strings.HasPrefix(os.Getenv("TUBESHELF_URL"), "https://")
}

// baseURL is the public origin, used for OIDC redirects.
func baseURL(r *http.Request) string {
	if v := os.Getenv("TUBESHELF_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	if v := os.Getenv("BETTER_AUTH_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	scheme := "http"
	if isHTTPS(r) {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func (s *Server) setSession(w http.ResponseWriter, r *http.Request, tok string) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: tok, Path: "/", HttpOnly: true,
		Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode, MaxAge: int(auth.SessionTTL.Seconds())})
}

// loadUser attaches the signed-in user (if any) to the request.
func (s *Server) loadUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c, err := r.Cookie(sessionCookie); err == nil {
			if u, renew, err := auth.SessionUser(s.DB, c.Value); err == nil {
				if renew {
					s.setSession(w, r, c.Value)
				}
				r = r.WithContext(context.WithValue(r.Context(), ctxKey{}, u))
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireUser(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u := s.user(r); u != nil {
			// A temporary password from an admin: choose your own before anything else.
			if u.MustChange && r.Method == http.MethodGet && r.URL.Path != "/account" && !isFetch(r) {
				http.Redirect(w, r, "/account?"+signFlash(url.Values{"msg": {"Choose your own password to continue."}}).Encode()+"#password", http.StatusSeeOther)
				return
			}
			next(w, r)
			return
		}
		if r.Method != http.MethodGet || r.Header.Get("X-Requested-With") != "" {
			http.Error(w, "sign in required", http.StatusUnauthorized)
			return
		}
		if auth.UserCount(s.DB) == 0 {
			http.Redirect(w, r, "/setup", http.StatusSeeOther)
			return
		}
		// Back to the page asked for once signed in.
		target := "/login"
		if r.URL.Path != "/" {
			target += "?next=" + url.QueryEscape(r.URL.RequestURI())
		}
		http.Redirect(w, r, target, http.StatusSeeOther)
	})
}

// localPath returns p if it is a path on this site, else "/".
func localPath(p string) string {
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.HasPrefix(p, "/\\") {
		return "/"
	}
	return p
}

// notFound is a page with a way back, not the bare Go 404 text.
func (s *Server) notFound(w http.ResponseWriter, r *http.Request) {
	if isFetch(r) || strings.HasPrefix(r.URL.Path, "/api/") || r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	s.render(w, r, "notfound", nil)
}

func (s *Server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.user(r).IsAdmin {
			if isFetch(r) || r.Method != http.MethodGet {
				http.Error(w, "admins only", http.StatusForbidden)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusForbidden)
			s.render(w, r, "forbidden", nil)
			return
		}
		next(w, r)
	}
}

// requireAPI accepts a session or an API key (X-API-Key or Bearer).
func (s *Server) requireAPI(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.user(r) == nil {
			key := strings.TrimSpace(r.Header.Get("X-API-Key"))
			if key == "" {
				key = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			}
			u, err := auth.APIKeyUser(s.DB, key)
			if err != nil {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in or send an API key"})
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), ctxKey{}, u))
		}
		next(w, r)
	})
}

// back redirects to where the form was submitted from, with a message.
func back(w http.ResponseWriter, r *http.Request, fallback, key, msg string) {
	target, _ := url.Parse(fallback)
	if ref, err := url.Parse(r.Referer()); err == nil && ref.Host == r.Host && ref.Path != "" {
		target = ref
	}
	q := target.Query()
	for _, k := range []string{"msg", "err", "go", "golabel", "typed", "fs"} {
		q.Del(k)
	}
	if msg != "" {
		// okThen and failKeep pack extra fields after NUL bytes.
		parts := strings.Split(msg, "\x00")
		q.Set(key, parts[0])
		if len(parts) == 3 && key == "msg" {
			q.Set("go", parts[1])
			q.Set("golabel", parts[2])
		} else if len(parts) == 3 {
			q.Set("typed", parts[2])
		}
	}
	target.RawQuery = signFlash(q).Encode()
	http.Redirect(w, r, target.RequestURI(), http.StatusSeeOther)
}

// flashKey signs the messages this process puts in redirect URLs. A restart
// forgets it, which only drops a message nobody has seen yet.
var flashKey = func() []byte { b := make([]byte, 32); rand.Read(b); return b }()

func flashMAC(q url.Values) string {
	m := hmac.New(sha256.New, flashKey)
	for _, k := range []string{"msg", "err", "go", "golabel"} {
		m.Write([]byte(q.Get(k) + "\x00"))
	}
	return hex.EncodeToString(m.Sum(nil)[:12])
}

// signFlash adds the signature that makes render show msg, err and go.
func signFlash(q url.Values) url.Values {
	if q.Get("msg") != "" || q.Get("err") != "" {
		q.Set("fs", flashMAC(q))
	}
	return q
}

func flashValid(q url.Values) bool {
	if q.Get("msg") == "" && q.Get("err") == "" {
		return true
	}
	return hmac.Equal([]byte(q.Get("fs")), []byte(flashMAC(q)))
}

func ok(w http.ResponseWriter, r *http.Request, fallback, msg string) {
	back(w, r, fallback, "msg", msg)
}

// okThen is ok with a link to the next step in the message.
func okThen(w http.ResponseWriter, r *http.Request, fallback, msg, goURL, label string) {
	back(w, r, fallback, "msg", msg+"\x00"+goURL+"\x00"+label)
}

// failKeep is fail that also keeps what was typed into the form (as ?typed=), so a typo can be fixed.
func failKeep(w http.ResponseWriter, r *http.Request, fallback string, err error, value string) {
	back(w, r, fallback, "err", err.Error()+"\x00typed\x00"+value)
}

// sentence makes an error read as one: a capital first letter and a full stop.
func sentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	r := []rune(s)
	r[0] = unicode.ToUpper(r[0])
	s = string(r)
	if !strings.ContainsAny(s[len(s)-1:], ".!?") {
		s += "."
	}
	return s
}
func fail(w http.ResponseWriter, r *http.Request, fallback string, err error) {
	back(w, r, fallback, "err", err.Error())
}

// isFetch reports a request made by app.js, which wants a bare status
// instead of a redirect.
func isFetch(r *http.Request) bool { return r.Header.Get("X-Requested-With") == "fetch" }

func clientIP(r *http.Request) string {
	if os.Getenv("TRUST_PROXY_HEADERS") != "" {
		// The last entry is the one the proxy added; earlier ones come from the client.
		if f := r.Header.Get("X-Forwarded-For"); f != "" {
			parts := strings.Split(f, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// limiter allows a few attempts per client in a time window.
type limiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

const limiterMax, limiterWindow = 10, 5 * time.Minute

// recent drops hits older than the window and returns the rest. Call with mu held.
func (l *limiter) recent(key string) []time.Time {
	if l.hits == nil {
		l.hits = map[string][]time.Time{}
	}
	now := time.Now()
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if now.Sub(t) < limiterWindow {
			kept = append(kept, t)
		}
	}
	l.hits[key] = kept
	return kept
}

// blocked reports whether key used up its attempts, without counting one.
func (l *limiter) blocked(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.recent(key)) >= limiterMax
}

// record counts one attempt for key.
func (l *limiter) record(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.hits[key] = append(l.recent(key), time.Now())
	if len(l.hits) > 10000 {
		l.hits = map[string][]time.Time{}
	}
}

// allow counts an attempt and reports whether it is within the limit.
func (l *limiter) allow(key string) bool {
	if l.blocked(key) {
		return false
	}
	l.record(key)
	return true
}

func ago(t int64) string {
	d := time.Since(time.Unix(t, 0))
	switch {
	case d < 0:
		return "scheduled"
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 30*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	case d < 365*24*time.Hour:
		return fmt.Sprintf("%dmo ago", int(d.Hours()/24/30))
	}
	return fmt.Sprintf("%dy ago", int(d.Hours()/24/365))
}

func dur(secs int64) string {
	if secs <= 0 {
		return ""
	}
	h, m, sec := secs/3600, secs%3600/60, secs%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, sec)
	}
	return fmt.Sprintf("%d:%02d", m, sec)
}

func pct(progress float64, duration int64) int {
	if duration <= 0 || progress <= 0 {
		return 0
	}
	return min(100, int(progress/float64(duration)*100))
}

func initial(s string) string {
	for _, r := range s {
		return strings.ToUpper(string(r))
	}
	return "?"
}

// queryWith returns the current query string with one key replaced (or
// removed when value is empty), for filter links.
func queryWith(q url.Values, key, value string) template.URL {
	out := url.Values{}
	for k, v := range q {
		if k != "before" && k != "fragment" && k != "msg" && k != "err" {
			out[k] = v
		}
	}
	if value == "" {
		out.Del(key)
	} else {
		out.Set(key, value)
	}
	if len(out) == 0 {
		return "?"
	}
	return template.URL("?" + out.Encode())
}

var reLink = regexp.MustCompile(`https?://[^\s<>"]+[^\s<>".,;:!?)\]'’]`)

// linkify escapes text and turns the web addresses in it into links that open
// in a new tab, for descriptions and comments.
func linkify(text string) template.HTML {
	var b strings.Builder
	last := 0
	for _, m := range reLink.FindAllStringIndex(text, -1) {
		b.WriteString(template.HTMLEscapeString(text[last:m[0]]))
		u := text[m[0]:m[1]]
		fmt.Fprintf(&b, `<a href="%s" target="_blank" rel="noopener nofollow ugc">%s</a>`, template.HTMLEscapeString(u), template.HTMLEscapeString(u))
		last = m[1]
	}
	b.WriteString(template.HTMLEscapeString(text[last:]))
	return template.HTML(b.String())
}
