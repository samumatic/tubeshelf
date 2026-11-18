package web

import (
	"cmp"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

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
	http.Redirect(w, r, localPath(r.FormValue("next")), http.StatusSeeOther)
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
		"Next":         r.URL.Query().Get("next"),
	})
}

func (s *Server) loginSubmit(w http.ResponseWriter, r *http.Request) {
	if providers, _ := auth.Providers(s.DB, true); db.Setting(s.DB, "oidc_only") == "1" && len(providers) > 0 {
		fail(w, r, "/login", errors.New("password login is disabled"))
		return
	}
	// Only wrong passwords count: a household behind one IP signs in often.
	if s.logins.blocked(clientIP(r)) {
		fail(w, r, "/login", errors.New("too many attempts, wait a few minutes"))
		return
	}
	u, err := auth.Login(s.DB, r.FormValue("email"), r.FormValue("password"))
	if err != nil {
		s.logins.record(clientIP(r))
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
	// Checked before creating the user: an admin without a password would
	// close setup for good with nobody able to sign in.
	if r.FormValue("password") == "" {
		fail(w, r, "/setup", errors.New("choose a password"))
		return
	}
	u, err := auth.CreateUser(s.DB, r.FormValue("email"), r.FormValue("name"), r.FormValue("password"), true)
	if err != nil {
		fail(w, r, "/setup", err)
		return
	}
	s.DB.Exec(`UPDATE users SET source = 'setup' WHERE id = ?`, u.ID)
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
	s.DB.Exec(`UPDATE users SET source = 'register' WHERE id = ?`, u.ID)
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
		http.Redirect(w, r, "/login?"+signFlash(url.Values{"err": {err.Error()}}).Encode(), http.StatusSeeOther)
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

func (s *Server) accountPage(w http.ResponseWriter, r *http.Request) {
	var sso string
	s.DB.QueryRow(`SELECT coalesce((SELECT p.name FROM oidc_providers p WHERE p.issuer = u.oidc_issuer LIMIT 1), 'your login provider')
		FROM users u WHERE u.id = ? AND u.oidc_subject IS NOT NULL`, s.user(r).ID).Scan(&sso)
	s.render(w, r, "account", M{"SSO": sso})
}

// unlinkSSO detaches the login provider; the account then signs in with its password only.
func (s *Server) unlinkSSO(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	if !u.HasPass {
		fail(w, r, "/account", errors.New("set a password first, or you could not sign in any more"))
		return
	}
	s.DB.Exec(`UPDATE users SET oidc_subject = NULL, oidc_issuer = NULL WHERE id = ?`, u.ID)
	ok(w, r, "/account", "Unlinked. Signing in through the provider again links it again; use your email and password instead.")
}

func (s *Server) preferencesPage(w http.ResponseWriter, r *http.Request) {
	s.render(w, r, "preferences", nil)
}

func (s *Server) keysPage(w http.ResponseWriter, r *http.Request) {
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
		http.SetCookie(w, &http.Cookie{Name: keyCookie, Path: "/account/keys", MaxAge: -1})
	}
	s.render(w, r, "keys", M{"Keys": keys, "NewKey": newKey})
}

// allowed values per user setting; nil means "0 or 1".
var userChoices = map[string][]string{
	"theme": {"system", "dark", "light"}, "view": {"grid", "list"}, "sort": {"newest", "oldest"},
	"sidebar":       {"expanded", "collapsed"},
	"sidebar_width": sidebarWidths(),
	"hide_shorts":   nil, "hide_watched": nil, "hide_members": nil, "hide_live": nil, "group_days": nil,
	"sponsorblock": nil, "open_on_youtube": nil, "captions": nil, "theater": nil, "autoplay_next": nil,
	"later_autoremove": nil, "click_to_load": nil,
}

// sidebarWidths are the sidebar widths a user can drag to: 208 to 400px in steps of 16, as in Pocket ID.
func sidebarWidths() []string {
	var out []string
	for w := 208; w <= 400; w += 16 {
		out = append(out, strconv.Itoa(w))
	}
	return out
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
	// The feed's filter buttons save here too; only the preferences page says so.
	msg := ""
	if ref, err := url.Parse(r.Referer()); err == nil && ref.Path == "/account/preferences" {
		msg = "Preferences saved"
	}
	ok(w, r, "/account/preferences", msg)
}

func (s *Server) saveProfile(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.FormValue("name"))
	if len(name) > 80 {
		fail(w, r, "/account", errors.New("name is too long"))
		return
	}
	s.DB.Exec(`UPDATE users SET name = ? WHERE id = ?`, name, s.user(r).ID)
	ok(w, r, "/account", "Profile saved")
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	if u.HasPass {
		if _, err := auth.Login(s.DB, u.Email, r.FormValue("current")); err != nil {
			fail(w, r, "/account", errors.New("current password is wrong"))
			return
		}
	}
	if err := auth.SetPassword(s.DB, u.ID, r.FormValue("new")); err != nil {
		fail(w, r, "/account", err)
		return
	}
	s.DB.Exec(`UPDATE users SET must_change_password = 0 WHERE id = ?`, u.ID)
	// SetPassword ended every session, including this one: start a fresh one.
	tok, err := auth.NewSession(s.DB, u.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.setSession(w, r, tok)
	ok(w, r, "/account", "Password changed, other devices were signed out")
}

func (s *Server) addAPIKey(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		name = "API key"
	}
	key, err := auth.NewAPIKey(s.DB, s.user(r).ID, name)
	if err != nil {
		fail(w, r, "/account/keys", err)
		return
	}
	// Shown once on the next page; only the hash is stored. A short-lived
	// cookie carries it there so the key never appears in a URL.
	http.SetCookie(w, &http.Cookie{Name: keyCookie, Value: key, Path: "/account/keys", HttpOnly: true,
		Secure: isHTTPS(r), SameSite: http.SameSiteStrictMode, MaxAge: 60})
	http.Redirect(w, r, "/account/keys", http.StatusSeeOther)
}

func (s *Server) deleteAPIKey(w http.ResponseWriter, r *http.Request) {
	s.DB.Exec(`DELETE FROM api_keys WHERE id = ? AND user_id = ?`, r.PathValue("id"), s.user(r).ID)
	ok(w, r, "/account/keys", "API key deleted")
}

// danger runs one of the destructive account actions. Each needs the
// confirmation checkbox.
func (s *Server) danger(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	if r.FormValue("confirm") != "1" {
		fail(w, r, "/account", errors.New("tick the confirmation box first"))
		return
	}
	switch r.FormValue("action") {
	case "history":
		s.DB.Exec(`DELETE FROM watch_state WHERE user_id = ?`, u.ID)
		ok(w, r, "/account", "Watch history and watched marks cleared")
	case "subscriptions":
		s.DB.Exec(`DELETE FROM lists WHERE user_id = ?`, u.ID)
		s.DB.Exec(`DELETE FROM subscriptions WHERE user_id = ?`, u.ID)
		ok(w, r, "/account", "All subscriptions and lists deleted")
	case "account":
		var admins int
		s.DB.QueryRow(`SELECT count(*) FROM users WHERE is_admin = 1 AND id != ?`, u.ID).Scan(&admins)
		if u.IsAdmin && admins == 0 {
			fail(w, r, "/account", errors.New("you are the only admin; make someone else admin first"))
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
	ID, Email, Name, Source, Provider string
	IsAdmin, OIDC, Disabled, HasPass  bool
	MustChange                        bool
	LastLogin, Created                int64
	Subs                              int
}

func (s *Server) adminUsersPage(w http.ResponseWriter, r *http.Request) {
	var users []AdminUser
	order := map[string]string{
		"name":   "lower(coalesce(nullif(u.name, ''), u.email))",
		"joined": "u.created_at DESC",
		"login":  "coalesce(u.last_login_at, 0) DESC",
	}
	sort := r.URL.Query().Get("sort")
	if order[sort] == "" {
		sort = "name"
	}
	rows, err := s.DB.Query(`SELECT u.id, u.email, u.name, u.is_admin, u.oidc_subject IS NOT NULL, coalesce((SELECT p.name FROM oidc_providers p WHERE p.issuer = u.oidc_issuer LIMIT 1), ''),
		u.disabled, u.password_hash IS NOT NULL, u.must_change_password, u.source, coalesce(u.last_login_at, 0), u.created_at,
		(SELECT count(*) FROM subscriptions s WHERE s.user_id = u.id)
		FROM users u ORDER BY ` + order[sort])
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var u AdminUser
		if rows.Scan(&u.ID, &u.Email, &u.Name, &u.IsAdmin, &u.OIDC, &u.Provider, &u.Disabled, &u.HasPass, &u.MustChange,
			&u.Source, &u.LastLogin, &u.Created, &u.Subs) == nil {
			users = append(users, u)
		}
	}
	data := M{"Users": users, "Sort": sort, "Add": r.URL.Query().Get("add") == "1", "Typed": r.URL.Query().Get("typed"),
		"SignIn": baseURL(r) + "/login", "NoPasswords": db.Setting(s.DB, "oidc_only") == "1"}
	// Right after adding someone: what to hand them.
	if id := r.URL.Query().Get("invite"); id != "" {
		if t, err := auth.UserByID(s.DB, id); err == nil && !t.HasPass {
			data["Invite"] = M{"Who": cmp.Or(t.Name, t.Email), "Link": s.inviteLink(r, id)}
		}
	}
	if id := r.URL.Query().Get("added"); id != "" {
		if t, err := auth.UserByID(s.DB, id); err == nil {
			data["Added"] = t
		}
	}
	s.render(w, r, "admin-users", data)
}

func (s *Server) instance() map[string]string {
	out := map[string]string{}
	for k := range db.Defaults {
		out[k] = db.Setting(s.DB, k)
	}
	return out
}

func (s *Server) adminSignInPage(w http.ResponseWriter, r *http.Request) {
	providers, _ := auth.Providers(s.DB, false)
	base := baseURL(r)
	u, _ := url.Parse(base)
	local := u != nil && (u.Hostname() == "localhost" || strings.HasPrefix(u.Hostname(), "127.") || u.Hostname() == "::1")
	s.render(w, r, "admin-signin", M{"Instance": s.instance(), "Providers": providers, "Callback": base + auth.CallbackPath, "LocalURL": local})
}

func (s *Server) adminInstancePage(w http.ResponseWriter, r *http.Request) {
	s.render(w, r, "admin-instance", M{"Instance": s.instance(), "Defaults": db.EffectiveDefaults(s.DB)})
}

func (s *Server) saveInstanceSettings(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	limits := map[string][2]int{"refresh_minutes": {5, 1440}, "fetch_concurrency": {1, 16}, "retention_days": {7, 3650}}
	for key, lim := range limits {
		if !r.PostForm.Has(key) {
			continue
		}
		n, err := strconv.Atoi(r.PostForm.Get(key))
		if err != nil || n < lim[0] || n > lim[1] {
			fail(w, r, "/admin/instance", errors.New(instanceLabels[key]+" must be a whole number from "+strconv.Itoa(lim[0])+" to "+strconv.Itoa(lim[1])))
			return
		}
		db.SetSetting(s.DB, key, strconv.Itoa(n))
	}
	// Switches send a hidden "0" first and "1" after it when on.
	for _, key := range []string{"public_registration", "oidc_only"} {
		vals := r.PostForm[key]
		if len(vals) == 0 {
			continue
		}
		v := "0"
		if vals[len(vals)-1] == "1" {
			v = "1"
		}
		db.SetSetting(s.DB, key, v)
	}
	ok(w, r, "/admin/instance", "Settings saved")
}

var instanceLabels = map[string]string{
	"refresh_minutes": "Check for new videos every … minutes", "fetch_concurrency": "Channels checked at once",
	"retention_days": "Keep videos for … days",
}

func (s *Server) refreshAll(w http.ResponseWriter, r *http.Request) {
	s.Fetcher.RefreshAll()
	ok(w, r, "/admin", "Checking all channels for new videos in the background. This page shows the result in a minute or two.")
}

func (s *Server) adminAddUser(w http.ResponseWriter, r *http.Request) {
	email, name, pw := strings.TrimSpace(r.FormValue("email")), strings.TrimSpace(r.FormValue("name")), r.FormValue("password")
	u, err := auth.CreateUser(s.DB, email, name, pw, r.FormValue("admin") == "1")
	if err != nil {
		failKeep(w, r, "/admin/users?add=1", err, email)
		return
	}
	who := cmp.Or(u.Name, u.Email)
	if pw == "" {
		// No password: the person gets a link to choose one.
		http.Redirect(w, r, "/admin/users?"+signFlash(url.Values{"msg": {"Added " + who + "."}, "invite": {u.ID}}).Encode(), http.StatusSeeOther)
		return
	}
	if r.FormValue("must_change") == "1" {
		s.DB.Exec(`UPDATE users SET must_change_password = 1 WHERE id = ?`, u.ID)
	}
	http.Redirect(w, r, "/admin/users?"+signFlash(url.Values{"msg": {"Added " + who + "."}, "added": {u.ID}}).Encode(), http.StatusSeeOther)
}

// inviteTTL is how long a link to choose a password works.
const inviteTTL = 7 * 24 * time.Hour

type invite struct {
	User    string `json:"u"`
	Expires int64  `json:"e"`
}

func (s *Server) inviteLink(r *http.Request, userID string) string {
	raw, _ := json.Marshal(invite{User: userID, Expires: time.Now().Add(inviteTTL).Unix()})
	return baseURL(r) + "/welcome?t=" + url.QueryEscape(s.Secret.Seal(string(raw)))
}

// inviteUser opens an invite token; only a user still without a password can use one.
func (s *Server) inviteUser(token string) (*auth.User, error) {
	raw, err := s.Secret.Open(token)
	var inv invite
	if err != nil || json.Unmarshal([]byte(raw), &inv) != nil || inv.Expires < time.Now().Unix() {
		return nil, errors.New("this link has expired or is not valid; ask your admin for a new one")
	}
	u, err := auth.UserByID(s.DB, inv.User)
	if err != nil || u.HasPass {
		return nil, errors.New("this link was already used; sign in with your email and password")
	}
	return u, nil
}

func (s *Server) welcomePage(w http.ResponseWriter, r *http.Request) {
	u, err := s.inviteUser(r.URL.Query().Get("t"))
	data := M{"Token": r.URL.Query().Get("t")}
	if err != nil {
		data["Err"] = sentence(err.Error())
	} else {
		data["Invited"] = u
	}
	s.render(w, r, "welcome", data)
}

func (s *Server) welcomeSubmit(w http.ResponseWriter, r *http.Request) {
	u, err := s.inviteUser(r.FormValue("t"))
	if err != nil {
		fail(w, r, "/login", err)
		return
	}
	if err := auth.SetPassword(s.DB, u.ID, r.FormValue("password")); err != nil {
		fail(w, r, "/welcome?t="+url.QueryEscape(r.FormValue("t")), err)
		return
	}
	s.signIn(w, r, u)
}

func (s *Server) adminUpdateUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	me := s.user(r)
	target, err := auth.UserByID(s.DB, id)
	if err != nil {
		fail(w, r, "/admin/users", errors.New("that user no longer exists"))
		return
	}
	who := cmp.Or(target.Name, target.Email)
	switch r.FormValue("action") {
	case "admin":
		if id == me.ID {
			fail(w, r, "/admin/users", errors.New("you cannot change your own admin rights; ask another admin"))
			return
		}
		on := r.FormValue("on") == "1"
		s.DB.Exec(`UPDATE users SET is_admin = ? WHERE id = ?`, on, id)
		if on {
			ok(w, r, "/admin/users", who+" is now an admin.")
		} else {
			ok(w, r, "/admin/users", who+" is no longer an admin.")
		}
	case "password":
		if err := auth.SetPassword(s.DB, id, r.FormValue("password")); err != nil {
			fail(w, r, "/admin/users", err)
			return
		}
		s.DB.Exec(`UPDATE users SET must_change_password = ? WHERE id = ?`, r.FormValue("must_change") == "1", id)
		http.Redirect(w, r, "/admin/users?"+signFlash(url.Values{"msg": {"New password set for " + who + ". They were signed out everywhere."}, "added": {id}}).Encode(), http.StatusSeeOther)
	case "invite":
		http.Redirect(w, r, "/admin/users?"+url.Values{"invite": {id}}.Encode(), http.StatusSeeOther)
	case "profile":
		name, email := strings.TrimSpace(r.FormValue("name")), strings.TrimSpace(r.FormValue("email"))
		if len(name) > 80 || !strings.Contains(email, "@") {
			fail(w, r, "/admin/users", errors.New("enter a valid email address and a name of at most 80 characters"))
			return
		}
		if _, err := s.DB.Exec(`UPDATE users SET name = ?, email = ? WHERE id = ?`, name, email, id); err != nil {
			fail(w, r, "/admin/users", auth.ErrEmailTaken)
			return
		}
		ok(w, r, "/admin/users", "Saved "+cmp.Or(name, email)+".")
	case "pause", "resume":
		if id == me.ID {
			fail(w, r, "/admin/users", errors.New("you cannot pause your own account"))
			return
		}
		pause := r.FormValue("action") == "pause"
		s.DB.Exec(`UPDATE users SET disabled = ? WHERE id = ?`, pause, id)
		if pause {
			s.DB.Exec(`DELETE FROM sessions WHERE user_id = ?`, id)
			ok(w, r, "/admin/users", who+" is paused: they cannot sign in until you turn the account back on.")
		} else {
			ok(w, r, "/admin/users", who+" can sign in again.")
		}
	case "delete":
		if id == me.ID {
			fail(w, r, "/admin/users", errors.New("delete your own account from My account"))
			return
		}
		if r.FormValue("confirm") != "1" {
			fail(w, r, "/admin/users", errors.New("tick the box to confirm first"))
			return
		}
		s.DB.Exec(`DELETE FROM users WHERE id = ?`, id)
		ok(w, r, "/admin/users", "Deleted "+who+" and their data.")
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
	if p.Enabled && p.Issuer != "" {
		if err := s.checkIssuer(r, p.Issuer); err != nil {
			fail(w, r, "/admin/sign-in", err)
			return
		}
	}
	var clash int
	s.DB.QueryRow(`SELECT count(*) FROM oidc_providers WHERE name = ? COLLATE NOCASE AND id != ?`, p.Name, p.ID).Scan(&clash)
	if clash > 0 {
		fail(w, r, "/admin/sign-in", errors.New("another provider is already called "+p.Name+"; the sign-in buttons need different names"))
		return
	}
	if err := auth.SaveProvider(s.DB, s.Secret, p, r.FormValue("client_secret")); err != nil {
		fail(w, r, "/admin/sign-in", err)
		return
	}
	msg := "Saved " + p.Name + ". The sign-in page now offers it."
	if !p.Enabled {
		msg = "Saved " + p.Name + ". It is off, so the sign-in page does not offer it."
	}
	if p.AdminGroup != "" {
		msg += " Admin rights now follow the " + p.AdminGroup + " group: people signing in through " + p.Name + " without it lose them (the last admin always keeps them)."
	}
	ok(w, r, "/admin/sign-in", msg)
}

func (s *Server) adminDeleteProvider(w http.ResponseWriter, r *http.Request) {
	s.DB.Exec(`DELETE FROM oidc_providers WHERE id = ?`, r.PathValue("id"))
	if providers, _ := auth.Providers(s.DB, true); len(providers) == 0 {
		db.SetSetting(s.DB, "oidc_only", "0") // never lock everyone out
	}
	ok(w, r, "/admin/sign-in", "Login provider deleted. Accounts that used it keep their data and can sign in with a password if they have one.")
}
