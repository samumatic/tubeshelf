package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// idp is a minimal OpenID Connect provider: discovery, keys and a token
// endpoint that checks the client secret and PKCE before signing an id token.
type idp struct {
	srv       *httptest.Server
	signer    jose.Signer
	nonce     string // echoed into the id token
	challenge string // PKCE challenge from the authorization request
	claims    map[string]any
}

func newIDP(t *testing.T) *idp {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key},
		(&jose.SignerOptions{}).WithHeader("kid", "k1"))
	if err != nil {
		t.Fatal(err)
	}
	p := &idp{signer: signer}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"issuer": p.srv.URL, "authorization_endpoint": p.srv.URL + "/authorize",
			"token_endpoint": p.srv.URL + "/token", "jwks_uri": p.srv.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		_, secret, _ := r.BasicAuth()
		if secret == "" {
			secret = r.Form.Get("client_secret")
		}
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if r.Form.Get("code") != "good-code" || secret != "idp-secret" ||
			base64.RawURLEncoding.EncodeToString(sum[:]) != p.challenge {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		claims := map[string]any{"iss": p.srv.URL, "aud": "client", "nonce": p.nonce,
			"iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix()}
		for k, v := range p.claims {
			claims[k] = v
		}
		tok, err := jwt.Signed(p.signer).Claims(claims).Serialize()
		if err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer", "id_token": tok})
	})
	p.srv = httptest.NewServer(mux)
	t.Cleanup(p.srv.Close)
	return p
}

// login runs one full authorization-code flow and returns the result.
func (p *idp) login(t *testing.T, env *oidcEnv, claims map[string]any) (*User, error) {
	t.Helper()
	redirect, cookie, err := OIDCStart(context.Background(), env.db, env.secret, env.providerID, "https://shelf.example")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	u, _ := url.Parse(redirect)
	q := u.Query()
	if !strings.HasPrefix(redirect, p.srv.URL+"/authorize") || q.Get("redirect_uri") != "https://shelf.example"+CallbackPath ||
		q.Get("code_challenge_method") != "S256" || q.Get("client_id") != "client" {
		t.Fatalf("unexpected authorization URL: %s", redirect)
	}
	p.nonce, p.challenge, p.claims = q.Get("nonce"), q.Get("code_challenge"), claims
	return OIDCFinish(context.Background(), env.db, env.secret, cookie, q.Get("state"), "good-code", "https://shelf.example")
}

type oidcEnv struct {
	db         *sql.DB
	secret     Secret
	providerID string
}

func TestOIDCLogin(t *testing.T) {
	d := testDB(t)
	p := newIDP(t)
	t.Setenv("TUBESHELF_SECRET", "s")
	secret, _ := LoadSecret(t.TempDir())
	if err := SaveProvider(d, secret, Provider{Name: "Fake", Issuer: p.srv.URL, ClientID: "client",
		AutoProvision: true, GroupClaim: "groups", AdminGroup: "admin", Enabled: true}, "idp-secret"); err != nil {
		t.Fatal(err)
	}
	providers, _ := Providers(d, true)
	if len(providers) != 1 || providers[0].ClientSecret == "idp-secret" {
		t.Fatalf("provider not stored, or its secret is stored in plain text: %+v", providers)
	}
	env := &oidcEnv{db: d, secret: secret, providerID: providers[0].ID}

	// First login creates the account; the group makes it admin.
	u, err := p.login(t, env, map[string]any{"sub": "sub-1", "email": "new@example.com", "name": "New", "groups": []string{"users", "admin"}})
	if err != nil {
		t.Fatalf("first login: %v", err)
	}
	if u.Email != "new@example.com" || u.Name != "New" || !u.IsAdmin || u.HasPass {
		t.Errorf("provisioned user: %+v", u)
	}

	// Same subject again: same account, and losing the group removes admin.
	again, err := p.login(t, env, map[string]any{"sub": "sub-1", "email": "changed@example.com", "groups": []string{"users"}})
	if err != nil || again.ID != u.ID || again.IsAdmin {
		t.Errorf("second login: %+v, %v", again, err)
	}

	// An existing local account is linked by email and keeps its password.
	local, _ := CreateUser(d, "local@example.com", "Local", "correct horse", false)
	linked, err := p.login(t, env, map[string]any{"sub": "sub-2", "email": "local@example.com"})
	if err != nil || linked.ID != local.ID || !linked.HasPass {
		t.Errorf("linking: %+v, %v", linked, err)
	}
	// A different subject must not take over an already linked account.
	if other, err := p.login(t, env, map[string]any{"sub": "sub-3", "email": "local@example.com"}); err == nil && other.ID == local.ID {
		t.Error("a second OIDC subject took over a linked account")
	}

	// Without auto-provisioning, unknown people are turned away.
	d.Exec(`UPDATE oidc_providers SET auto_provision = 0`)
	if _, err := p.login(t, env, map[string]any{"sub": "sub-9", "email": "stranger@example.com"}); err == nil {
		t.Error("unknown user was let in although auto-provisioning is off")
	}
}

func TestOIDCRejectsForgedCallbacks(t *testing.T) {
	d := testDB(t)
	p := newIDP(t)
	secret, _ := LoadSecret(t.TempDir())
	SaveProvider(d, secret, Provider{Name: "Fake", Issuer: p.srv.URL, ClientID: "client", AutoProvision: true, Enabled: true}, "idp-secret")
	providers, _ := Providers(d, true)
	base := "https://shelf.example"
	start := func() (cookie, state string) {
		redirect, cookie, err := OIDCStart(context.Background(), d, secret, providers[0].ID, base)
		if err != nil {
			t.Fatal(err)
		}
		u, _ := url.Parse(redirect)
		p.nonce, p.challenge = u.Query().Get("nonce"), u.Query().Get("code_challenge")
		p.claims = map[string]any{"sub": "s", "email": "a@example.com"}
		return cookie, u.Query().Get("state")
	}
	ctx := context.Background()

	cookie, state := start()
	if _, err := OIDCFinish(ctx, d, secret, cookie, state+"x", "good-code", base); err == nil {
		t.Error("wrong state accepted")
	}
	if _, err := OIDCFinish(ctx, d, secret, "forged", state, "good-code", base); err == nil {
		t.Error("forged flow cookie accepted")
	}
	if _, err := OIDCFinish(ctx, d, secret, cookie, state, "bad-code", base); err == nil {
		t.Error("bad authorization code accepted")
	}
	// An id token minted for another login attempt (other nonce) is refused.
	cookie, state = start()
	p.nonce = "someone-elses-nonce"
	if _, err := OIDCFinish(ctx, d, secret, cookie, state, "good-code", base); err == nil {
		t.Error("id token with a foreign nonce accepted")
	}
	if n := UserCount(d); n != 0 {
		t.Errorf("%d users created by rejected logins", n)
	}
	if _, _, err := OIDCStart(ctx, d, secret, "no-such-provider", base); err == nil {
		t.Error("unknown provider accepted")
	}
}
