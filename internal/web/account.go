package web

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/samumatic/tubeshelf/internal/auth"
	"github.com/samumatic/tubeshelf/internal/db"
)

const (
	flowCookie = "tubeshelf_oidc"
	keyCookie  = "tubeshelf_newkey"
)

func (s *Server) signIn(w http.ResponseWriter, r *http.Request, u *auth.User) {
	tok, err := auth.NewSession(s.DB, u.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.setSession(w, r, tok)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) loginPage(w http.ResponseWriter, r *http.Request) {
	if auth.UserCount(s.DB) == 0 {
		http.Redirect(w, r, "/setup", http.StatusSeeOther)
		return
	}
	if s.user(r) != nil {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	providers, _ := auth.Providers(s.DB, true)
	s.render(w, r, "login", M{
		"Providers":    providers,
		"OIDCOnly":     db.Setting(s.DB, "oidc_only") == "1" && len(providers) > 0,
		"Registration": db.Setting(s.DB, "public_registration") == "1",
	})
}

func (s *Server) loginSubmit(w http.ResponseWriter, r *http.Request) {
	if providers, _ := auth.Providers(s.DB, true); db.Setting(s.DB, "oidc_only") == "1" && len(providers) > 0 {
		fail(w, r, "/login", errors.New("password login is disabled"))
		return
	}
	if !s.logins.allow(clientIP(r)) {
		fail(w, r, "/login", errors.New("too many attempts, wait a few minutes"))
		return
	}
	u, err := auth.Login(s.DB, r.FormValue("email"), r.FormValue("password"))
	if err != nil {
		fail(w, r, "/login", err)
		return
	}
	s.signIn(w, r, u)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		auth.EndSession(s.DB, c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Path: "/", MaxAge: -1})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

// Setup creates the first admin and is only reachable while no user exists.
func (s *Server) setupPage(w http.ResponseWriter, r *http.Request) {
	if auth.UserCount(s.DB) > 0 {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	s.render(w, r, "setup", nil)
}

func (s *Server) setupSubmit(w http.ResponseWriter, r *http.Request) {
	if auth.UserCount(s.DB) > 0 {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	u, err := auth.CreateUser(s.DB, r.FormValue("email"), r.FormValue("name"), r.FormValue("password"), true)
	if err == nil && r.FormValue("password") == "" {
		err = errors.New("choose a password")
	}
	if err != nil {
		fail(w, r, "/setup", err)
		return
	}
	s.signIn(w, r, u)
}

func (s *Server) registerPage(w http.ResponseWriter, r *http.Request) {
	if db.Setting(s.DB, "public_registration") != "1" {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	s.render(w, r, "register", nil)
}

func (s *Server) registerSubmit(w http.ResponseWriter, r *http.Request) {
	if db.Setting(s.DB, "public_registration") != "1" || db.Setting(s.DB, "oidc_only") == "1" {
		http.Error(w, "registration is closed", http.StatusForbidden)
		return
	}
	if !s.logins.allow(clientIP(r)) {
		fail(w, r, "/register", errors.New("too many attempts, wait a few minutes"))
		return
	}
	if r.FormValue("password") == "" {
		fail(w, r, "/register", errors.New("choose a password"))
		return
	}
	u, err := auth.CreateUser(s.DB, r.FormValue("email"), r.FormValue("name"), r.FormValue("password"), false)
	if err != nil {
		fail(w, r, "/register", err)
		return
	}
	s.signIn(w, r, u)
}

func (s *Server) oidcStart(w http.ResponseWriter, r *http.Request) {
	redirect, cookie, err := auth.OIDCStart(r.Context(), s.DB, s.Secret, r.URL.Query().Get("provider"), baseURL(r))
	if err != nil {
		fail(w, r, "/login", err)
		return
	}
	// Lax so the cookie comes back on the provider's redirect to the callback.
	http.SetCookie(w, &http.Cookie{Name: flowCookie, Value: cookie, Path: "/api/auth/oidc", HttpOnly: true,
		Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode, MaxAge: 600})
	http.Redirect(w, r, redirect, http.StatusFound)
}

func (s *Server) oidcCallback(w http.ResponseWriter, r *http.Request) {
	loginErr := func(err error) {
		http.Redirect(w, r, "/login?err="+url.QueryEscape(err.Error()), http.StatusSeeOther)
	}
	c, err := r.Cookie(flowCookie)
	if err != nil {
		loginErr(errors.New("login expired, try again"))
		return
	}
	http.SetCookie(w, &http.Cookie{Name: flowCookie, Path: "/api/auth/oidc", MaxAge: -1})
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		loginErr(errors.New("login provider refused: " + e))
		return
	}
	u, err := auth.OIDCFinish(r.Context(), s.DB, s.Secret, c.Value, q.Get("state"), q.Get("code"), baseURL(r))
	if err != nil {
		loginErr(err)
		return
	}
	s.signIn(w, r, u)
}

type APIKey struct {
	ID, Name          string
	Created, LastUsed int64
}

func (s *Server) settingsPage(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	var keys []APIKey
	rows, err := s.DB.Query(`SELECT id, name, created_at, coalesce(last_used_at, 0) FROM api_keys WHERE user_id = ? ORDER BY created_at`, u.ID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var k APIKey
			if rows.Scan(&k.ID, &k.Name, &k.Created, &k.LastUsed) == nil {
				keys = append(keys, k)
			}
		}
	}
	newKey := ""
	if c, err := r.Cookie(keyCookie); err == nil {
		newKey = c.Value
		http.SetCookie(w, &http.Cookie{Name: keyCookie, Path: "/settings", MaxAge: -1})
	}
	s.render(w, r, "settings", M{"Keys": keys, "NewKey": newKey})
}

// allowed values per user setting; nil means "0 or 1".
var userChoices = map[string][]string{
	"theme": {"system", "dark", "light"}, "view": {"grid", "list"}, "sort": {"newest", "oldest"},
	"sidebar":     {"expanded", "collapsed"},
	"hide_shorts": nil, "hide_watched": nil, "hide_members": nil, "hide_live": nil,
	"sponsorblock": nil, "open_on_youtube": nil,
}

// saveSettings stores whichever known settings the form sent, so the feed's
// one-button filter forms and the full settings form share it.
func (s *Server) saveSettings(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	r.ParseForm()
	for key, choices := range userChoices {
		if !r.PostForm.Has(key) {
			continue
		}
		// Checkboxes send a hidden "0" first and "1" after it when ticked.
		v := r.PostForm[key][len(r.PostForm[key])-1]
		valid := choices == nil && (v == "0" || v == "1")
		for _, c := range choices {
			valid = valid || c == v
		}
		if valid {
			db.SetUserSetting(s.DB, u.ID, key, v)
		}
	}
	if v := r.PostForm.Get("watched_percent"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 25 && n <= 100 {
			db.SetUserSetting(s.DB, u.ID, "watched_percent", v)
		}
	}
	if isFetch(r) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ok(w, r, "/settings", "")
}

func (s *Server) saveProfile(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.FormValue("name"))
	if len(name) > 80 {
		fail(w, r, "/settings", errors.New("name is too long"))
		return
	}
	s.DB.Exec(`UPDATE users SET name = ? WHERE id = ?`, name, s.user(r).ID)
	ok(w, r, "/settings", "Profile saved")
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	if u.HasPass {
		if _, err := auth.Login(s.DB, u.Email, r.FormValue("current")); err != nil {
			fail(w, r, "/settings", errors.New("current password is wrong"))
			return
		}
	}
	if err := auth.SetPassword(s.DB, u.ID, r.FormValue("new")); err != nil {
		fail(w, r, "/settings", err)
		return
	}
	// SetPassword ended every session, including this one: start a fresh one.
	tok, err := auth.NewSession(s.DB, u.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.setSession(w, r, tok)
	ok(w, r, "/settings", "Password changed, other devices were signed out")
}

func (s *Server) addAPIKey(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		name = "API key"
	}
	key, err := auth.NewAPIKey(s.DB, s.user(r).ID, name)
	if err != nil {
		fail(w, r, "/settings", err)
		return
	}
	// Shown once on the next page; only the hash is stored. A short-lived
	// cookie carries it there so the key never appears in a URL.
	http.SetCookie(w, &http.Cookie{Name: keyCookie, Value: key, Path: "/settings", HttpOnly: true,
		Secure: isHTTPS(r), SameSite: http.SameSiteStrictMode, MaxAge: 60})
	http.Redirect(w, r, "/settings#keys", http.StatusSeeOther)
}

func (s *Server) deleteAPIKey(w http.ResponseWriter, r *http.Request) {
	s.DB.Exec(`DELETE FROM api_keys WHERE id = ? AND user_id = ?`, r.PathValue("id"), s.user(r).ID)
	ok(w, r, "/settings", "API key deleted")
}

// danger runs one of the destructive account actions. Each needs the
// confirmation checkbox.
func (s *Server) danger(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	if r.FormValue("confirm") != "1" {
		fail(w, r, "/settings", errors.New("tick the confirmation box first"))
		return
	}
	switch r.FormValue("action") {
	case "history":
		s.DB.Exec(`DELETE FROM watch_state WHERE user_id = ?`, u.ID)
		ok(w, r, "/settings", "Watch history and watched marks cleared")
	case "subscriptions":
		s.DB.Exec(`DELETE FROM lists WHERE user_id = ?`, u.ID)
		s.DB.Exec(`DELETE FROM subscriptions WHERE user_id = ?`, u.ID)
		ok(w, r, "/settings", "All subscriptions and lists deleted")
	case "account":
		var admins int
		s.DB.QueryRow(`SELECT count(*) FROM users WHERE is_admin = 1 AND id != ?`, u.ID).Scan(&admins)
		if u.IsAdmin && admins == 0 {
			fail(w, r, "/settings", errors.New("you are the only admin; make someone else admin first"))
			return
		}
		s.DB.Exec(`DELETE FROM users WHERE id = ?`, u.ID)
		http.SetCookie(w, &http.Cookie{Name: sessionCookie, Path: "/", MaxAge: -1})
		http.Redirect(w, r, "/login", http.StatusSeeOther)
	default:
		http.Error(w, "unknown action", http.StatusBadRequest)
	}
}

type AdminUser struct {
	ID, Email, Name string
	IsAdmin, OIDC   bool
	LastLogin       int64
	Subs            int
}

type Health struct {
	Channels, Failing, Videos, Pending int
	LastFetch                          int64
}

func (s *Server) adminPage(w http.ResponseWriter, r *http.Request) {
	var users []AdminUser
	rows, err := s.DB.Query(`SELECT id, email, name, is_admin, oidc_subject IS NOT NULL, coalesce(last_login_at, 0),
		(SELECT count(*) FROM subscriptions s WHERE s.user_id = users.id) FROM users ORDER BY created_at`)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var u AdminUser
		if rows.Scan(&u.ID, &u.Email, &u.Name, &u.IsAdmin, &u.OIDC, &u.LastLogin, &u.Subs) == nil {
			users = append(users, u)
		}
	}
	var h Health
	s.DB.QueryRow(`SELECT count(*), coalesce(sum(fail_count > 0), 0), coalesce(max(last_success_at), 0) FROM channels`).
		Scan(&h.Channels, &h.Failing, &h.LastFetch)
	s.DB.QueryRow(`SELECT count(*), coalesce(sum(enrich_after > 0), 0) FROM videos`).Scan(&h.Videos, &h.Pending)
	instance := map[string]string{}
	for k := range db.Defaults {
		instance[k] = db.Setting(s.DB, k)
	}
	providers, _ := auth.Providers(s.DB, false)
	s.render(w, r, "admin", M{"Users": users, "Health": h, "Instance": instance, "Providers": providers,
		"Callback": baseURL(r) + auth.CallbackPath})
}

func (s *Server) saveInstanceSettings(w http.ResponseWriter, r *http.Request) {
	limits := map[string][2]int{"refresh_minutes": {5, 1440}, "fetch_concurrency": {1, 16}, "retention_days": {7, 3650}}
	for key, lim := range limits {
		n, err := strconv.Atoi(r.FormValue(key))
		if err != nil || n < lim[0] || n > lim[1] {
			fail(w, r, "/admin", errors.New(strings.ReplaceAll(key, "_", " ")+" must be between "+strconv.Itoa(lim[0])+" and "+strconv.Itoa(lim[1])))
			return
		}
		db.SetSetting(s.DB, key, strconv.Itoa(n))
	}
	for _, key := range []string{"public_registration", "oidc_only"} {
		v := "0"
		if r.FormValue(key) == "1" {
			v = "1"
		}
		db.SetSetting(s.DB, key, v)
	}
	ok(w, r, "/admin", "Settings saved")
}

func (s *Server) refreshAll(w http.ResponseWriter, r *http.Request) {
	s.Fetcher.RefreshAll()
	ok(w, r, "/admin", "Refreshing all channels in the background")
}

func (s *Server) adminAddUser(w http.ResponseWriter, r *http.Request) {
	if r.FormValue("password") == "" {
		fail(w, r, "/admin", errors.New("set an initial password"))
		return
	}
	if _, err := auth.CreateUser(s.DB, r.FormValue("email"), r.FormValue("name"), r.FormValue("password"), r.FormValue("admin") == "1"); err != nil {
		fail(w, r, "/admin", err)
		return
	}
	ok(w, r, "/admin", "User created")
}

func (s *Server) adminUpdateUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	me := s.user(r)
	switch r.FormValue("action") {
	case "admin":
		if id == me.ID {
			fail(w, r, "/admin", errors.New("you cannot change your own admin role"))
			return
		}
		s.DB.Exec(`UPDATE users SET is_admin = ? WHERE id = ?`, r.FormValue("on") == "1", id)
		ok(w, r, "/admin", "Role updated")
	case "password":
		if err := auth.SetPassword(s.DB, id, r.FormValue("password")); err != nil {
			fail(w, r, "/admin", err)
			return
		}
		ok(w, r, "/admin", "Password reset, that user was signed out")
	case "delete":
		if id == me.ID {
			fail(w, r, "/admin", errors.New("delete your own account from Settings"))
			return
		}
		if r.FormValue("confirm") != "1" {
			fail(w, r, "/admin", errors.New("tick the confirmation box first"))
			return
		}
		s.DB.Exec(`DELETE FROM users WHERE id = ?`, id)
		ok(w, r, "/admin", "User deleted")
	default:
		http.Error(w, "unknown action", http.StatusBadRequest)
	}
}

func (s *Server) adminSaveProvider(w http.ResponseWriter, r *http.Request) {
	p := auth.Provider{
		ID: r.FormValue("id"), Name: strings.TrimSpace(r.FormValue("name")), Issuer: r.FormValue("issuer"),
		ClientID: strings.TrimSpace(r.FormValue("client_id")), Scopes: strings.TrimSpace(r.FormValue("scopes")),
		AutoProvision: r.FormValue("auto_provision") == "1", GroupClaim: strings.TrimSpace(r.FormValue("group_claim")),
		AdminGroup: strings.TrimSpace(r.FormValue("admin_group")), Enabled: r.FormValue("enabled") == "1",
	}
	if err := auth.SaveProvider(s.DB, s.Secret, p, r.FormValue("client_secret")); err != nil {
		fail(w, r, "/admin", err)
		return
	}
	ok(w, r, "/admin", "Login provider saved")
}

func (s *Server) adminDeleteProvider(w http.ResponseWriter, r *http.Request) {
	s.DB.Exec(`DELETE FROM oidc_providers WHERE id = ?`, r.PathValue("id"))
	if providers, _ := auth.Providers(s.DB, true); len(providers) == 0 {
		db.SetSetting(s.DB, "oidc_only", "0") // never lock everyone out
	}
	ok(w, r, "/admin", "Login provider deleted")
}
