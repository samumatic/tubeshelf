package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/samumatic/tubeshelf/internal/auth"
	"github.com/samumatic/tubeshelf/internal/db"
)

func TestCLIOIDCAndUserList(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	var out strings.Builder

	// Enabling without a provider would lock everyone out.
	if err := oidcToggle(d, []string{"enable"}, &out); err == nil || db.Setting(d, "oidc_only") == "1" {
		t.Fatal("OIDC-only was enabled without any login provider")
	}
	d.Exec(`INSERT INTO oidc_providers (id, name, issuer, client_id, client_secret) VALUES ('p', 'IdP', 'https://idp.example', 'c', 'x')`)
	if err := oidcToggle(d, []string{"enable"}, &out); err != nil || db.Setting(d, "oidc_only") != "1" {
		t.Fatalf("enable: %v", err)
	}
	if err := oidcToggle(d, nil, &out); err != nil || db.Setting(d, "oidc_only") != "0" {
		t.Fatalf("toggle without argument did not flip it back: %v", err)
	}
	if err := oidcToggle(d, []string{"maybe"}, &out); err == nil {
		t.Error("unknown argument accepted")
	}
	out.Reset()
	oidcStatus(d, &out)
	if !strings.Contains(out.String(), "DISABLED") {
		t.Errorf("status: %q", out.String())
	}

	auth.CreateUser(d, "admin@example.com", "Ada", "correct horse", true)
	d.Exec(`INSERT INTO users (id, email, oidc_issuer, oidc_subject, created_at) VALUES ('o', 'sso@example.com', 'https://idp.example', 's', 0)`)
	out.Reset()
	if err := userList(d, &out); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{"admin@example.com", "Ada", "admin", "password", "sso@example.com", "oidc", "2 user(s)"} {
		if !strings.Contains(got, want) {
			t.Errorf("user-list misses %q:\n%s", want, got)
		}
	}
}
