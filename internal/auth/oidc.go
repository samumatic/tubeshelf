package auth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// CallbackPath is the same path v1 used, so identity providers need no change.
const CallbackPath = "/api/auth/oidc/callback"

type Provider struct {
	ID            string
	Name          string
	Issuer        string
	ClientID      string
	ClientSecret  string // sealed with Secret
	Scopes        string
	AutoProvision bool
	GroupClaim    string
	AdminGroup    string
	Enabled       bool
}

const providerCols = `id, name, issuer, client_id, client_secret, scopes, auto_provision, group_claim, admin_group, enabled`

func Providers(d *sql.DB, enabledOnly bool) ([]Provider, error) {
	q := `SELECT ` + providerCols + ` FROM oidc_providers`
	if enabledOnly {
		q += ` WHERE enabled = 1`
	}
	rows, err := d.Query(q + ` ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Provider
	for rows.Next() {
		var p Provider
		if err := rows.Scan(&p.ID, &p.Name, &p.Issuer, &p.ClientID, &p.ClientSecret, &p.Scopes,
			&p.AutoProvision, &p.GroupClaim, &p.AdminGroup, &p.Enabled); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func providerByID(d *sql.DB, id string) (*Provider, error) {
	var p Provider
	err := d.QueryRow(`SELECT `+providerCols+` FROM oidc_providers WHERE id = ? AND enabled = 1`, id).
		Scan(&p.ID, &p.Name, &p.Issuer, &p.ClientID, &p.ClientSecret, &p.Scopes,
			&p.AutoProvision, &p.GroupClaim, &p.AdminGroup, &p.Enabled)
	return &p, err
}

// SaveProvider inserts or updates a provider. An empty plainSecret keeps the stored one.
func SaveProvider(d *sql.DB, s Secret, p Provider, plainSecret string) error {
	p.Issuer = strings.TrimSpace(p.Issuer)
	if p.Name == "" || p.Issuer == "" || p.ClientID == "" {
		return errors.New("name, issuer and client id are required")
	}
	if p.Scopes == "" {
		p.Scopes = "openid profile email"
	}
	if p.ID == "" {
		if plainSecret == "" {
			return errors.New("client secret is required")
		}
		p.ID = NewID()
		_, err := d.Exec(`INSERT INTO oidc_providers (`+providerCols+`) VALUES (?,?,?,?,?,?,?,?,?,?)`,
			p.ID, p.Name, p.Issuer, p.ClientID, s.Seal(plainSecret), p.Scopes, p.AutoProvision, p.GroupClaim, p.AdminGroup, p.Enabled)
		return err
	}
	_, err := d.Exec(`UPDATE oidc_providers SET name=?, issuer=?, client_id=?, scopes=?, auto_provision=?,
		group_claim=?, admin_group=?, enabled=? WHERE id=?`,
		p.Name, p.Issuer, p.ClientID, p.Scopes, p.AutoProvision, p.GroupClaim, p.AdminGroup, p.Enabled, p.ID)
	if err == nil && plainSecret != "" {
		_, err = d.Exec(`UPDATE oidc_providers SET client_secret = ? WHERE id = ?`, s.Seal(plainSecret), p.ID)
	}
	return err
}

// flow is the login attempt, sealed into a short-lived cookie between
// redirect and callback.
type flow struct {
	Provider string `json:"p"`
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
	Expires  int64  `json:"e"`
}

func (p *Provider) config(ctx context.Context, s Secret, baseURL string) (*oidc.Provider, *oauth2.Config, error) {
	op, err := oidc.NewProvider(ctx, p.Issuer)
	if err != nil {
		return nil, nil, providerFailed(fmt.Errorf("oidc discovery for %s: %w", p.Name, err))
	}
	secret, err := s.Open(p.ClientSecret)
	if err != nil {
		return nil, nil, fmt.Errorf("client secret of %s cannot be decrypted; save it again in Admin", p.Name)
	}
	return op, &oauth2.Config{
		ClientID:     p.ClientID,
		ClientSecret: secret,
		Endpoint:     op.Endpoint(),
		RedirectURL:  baseURL + CallbackPath,
		Scopes:       strings.Fields(p.Scopes),
	}, nil
}

// OIDCStart returns the provider URL to redirect to and the sealed cookie
// value that OIDCFinish needs back.
func OIDCStart(ctx context.Context, d *sql.DB, s Secret, providerID, baseURL string) (redirect, cookie string, err error) {
	ctx, cancel := providerContext(ctx)
	defer cancel()
	p, err := providerByID(d, providerID)
	if err != nil {
		return "", "", errors.New("unknown login provider")
	}
	_, cfg, err := p.config(ctx, s, baseURL)
	if err != nil {
		return "", "", err
	}
	f := flow{Provider: p.ID, State: newToken(), Nonce: newToken(), Verifier: oauth2.GenerateVerifier(),
		Expires: time.Now().Add(10 * time.Minute).Unix()}
	raw, _ := json.Marshal(f)
	return cfg.AuthCodeURL(f.State, oidc.Nonce(f.Nonce), oauth2.S256ChallengeOption(f.Verifier)), s.Seal(string(raw)), nil
}

// OIDCFinish validates the callback and returns the matching local user,
// creating one when the provider allows auto-provisioning.
func OIDCFinish(ctx context.Context, d *sql.DB, s Secret, cookie, state, code, baseURL string) (*User, error) {
	ctx, cancel := providerContext(ctx)
	defer cancel()
	raw, err := s.Open(cookie)
	if err != nil {
		return nil, errors.New("login expired, try again")
	}
	var f flow
	if json.Unmarshal([]byte(raw), &f) != nil || f.Expires < time.Now().Unix() || f.State == "" || f.State != state {
		return nil, errors.New("login expired, try again")
	}
	p, err := providerByID(d, f.Provider)
	if err != nil {
		return nil, errors.New("unknown login provider")
	}
	op, cfg, err := p.config(ctx, s, baseURL)
	if err != nil {
		return nil, err
	}
	tok, err := cfg.Exchange(ctx, code, oauth2.VerifierOption(f.Verifier))
	if err != nil {
		return nil, providerFailed(fmt.Errorf("oidc code exchange: %w", err))
	}
	rawID, _ := tok.Extra("id_token").(string)
	idTok, err := op.Verifier(&oidc.Config{ClientID: p.ClientID}).Verify(ctx, rawID)
	if err != nil {
		return nil, providerFailed(fmt.Errorf("oidc id token: %w", err))
	}
	if idTok.Nonce != f.Nonce {
		return nil, providerFailed(errors.New("oidc nonce mismatch"))
	}
	claims := map[string]any{}
	if err := idTok.Claims(&claims); err != nil {
		return nil, err
	}
	// Some providers only put profile claims on the userinfo endpoint.
	if _, ok := claims["email"]; !ok {
		// Only when it describes the same person as the token.
		if info, err := op.UserInfo(ctx, cfg.TokenSource(ctx, tok)); err == nil && info.Subject == idTok.Subject {
			info.Claims(&claims)
		}
	}
	email, _ := claims["email"].(string)
	// A provider that lets people type any address marks it unverified; such an
	// address must not open the local account that has it. No claim: trust the provider.
	if v, ok := claims["email_verified"].(bool); ok && !v {
		email = ""
	}
	name, _ := claims["name"].(string)
	admin := p.AdminGroup != "" && hasGroup(claims[p.GroupClaim], p.AdminGroup)
	return oidcUser(d, p, idTok.Subject, email, name, admin)
}

func hasGroup(claim any, want string) bool {
	switch v := claim.(type) {
	case string:
		return v == want
	case []any:
		for _, g := range v {
			if s, _ := g.(string); s == want {
				return true
			}
		}
	}
	return false
}

func oidcUser(d *sql.DB, p *Provider, subject, email, name string, admin bool) (*User, error) {
	// Admin follows the group only when a group mapping is configured.
	sync := func(id string) (*User, error) {
		if p.AdminGroup != "" {
			d.Exec(`UPDATE users SET is_admin = ? WHERE id = ?`, admin, id)
		}
		return UserByID(d, id)
	}
	var id string
	if d.QueryRow(`SELECT id FROM users WHERE oidc_issuer = ? AND oidc_subject = ?`, p.Issuer, subject).Scan(&id) == nil {
		return sync(id)
	}
	if email == "" {
		return nil, errors.New("the login provider did not share a verified email address")
	}
	// First OIDC login of an existing local account links it by email.
	if d.QueryRow(`SELECT id FROM users WHERE email = ? AND oidc_subject IS NULL`, email).Scan(&id) == nil {
		d.Exec(`UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ?`, p.Issuer, subject, id)
		return sync(id)
	}
	if !p.AutoProvision {
		return nil, errors.New("no account exists for " + email + "; ask an admin to create one")
	}
	// A long name from the provider is shortened rather than refusing the login.
	for len(name) > 80 {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	u, err := CreateUser(d, email, name, "", admin)
	if err != nil {
		return nil, err
	}
	d.Exec(`UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ?`, p.Issuer, subject, u.ID)
	return u, nil
}

// providerContext bounds every call to the login provider, so one that accepts
// connections but never answers cannot hang the login.
func providerContext(ctx context.Context) (context.Context, context.CancelFunc) {
	client := &http.Client{Timeout: 15 * time.Second}
	ctx = context.WithValue(oidc.ClientContext(ctx, client), oauth2.HTTPClient, client)
	return context.WithTimeout(ctx, 30*time.Second)
}

// errProviderFailed is what people who are not signed in see; the details
// (addresses, issuers, token times) only go to the server log.
var errProviderFailed = errors.New("sign-in with the login provider failed; an admin can find the reason in the server log")

func providerFailed(err error) error {
	slog.Warn("oidc login failed", "err", err)
	return errProviderFailed
}
