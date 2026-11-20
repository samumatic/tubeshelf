package main

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"

	"github.com/samumatic/tubeshelf/internal/auth"
	"github.com/samumatic/tubeshelf/internal/db"
)

// oidcToggle turns "OIDC only" sign-in on or off ("enable", "disable"), or
// flips it without an argument, as v1's CLI did.
func oidcToggle(d *sql.DB, args []string, out io.Writer) error {
	on := db.Setting(d, "oidc_only") != "1"
	if len(args) > 0 {
		switch strings.ToLower(args[0]) {
		case "enable", "on":
			on = true
		case "disable", "off":
			on = false
		default:
			return errors.New("usage: tubeshelf oidc-toggle [enable|disable]")
		}
	}
	if on {
		if providers, _ := auth.Providers(d, true); len(providers) == 0 {
			return errors.New("cannot enable OIDC-only sign-in without an enabled login provider; add one under Administration first")
		}
	}
	v := "0"
	if on {
		v = "1"
	}
	if err := db.SetSetting(d, "oidc_only", v); err != nil {
		return err
	}
	return oidcStatus(d, out)
}

func oidcStatus(d *sql.DB, out io.Writer) error {
	state := "DISABLED: password and OIDC sign-in both work"
	if db.Setting(d, "oidc_only") == "1" {
		state = "ENABLED: only OIDC sign-in works"
	}
	_, err := fmt.Fprintln(out, "OIDC-only mode is", state)
	return err
}

// userList prints every user and how they sign in.
func userList(d *sql.DB, out io.Writer) error {
	rows, err := d.Query(`SELECT email, name, is_admin, password_hash IS NOT NULL, oidc_subject IS NOT NULL FROM users ORDER BY email`)
	if err != nil {
		return err
	}
	defer rows.Close()
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "EMAIL\tNAME\tROLE\tSIGN-IN")
	n := 0
	for rows.Next() {
		var email, name string
		var admin, pass, oidc bool
		if err := rows.Scan(&email, &name, &admin, &pass, &oidc); err != nil {
			return err
		}
		role := "user"
		if admin {
			role = "admin"
		}
		var how []string
		if pass {
			how = append(how, "password")
		}
		if oidc {
			how = append(how, "oidc")
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", email, name, role, strings.Join(how, "+"))
		n++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	w.Flush()
	_, err = fmt.Fprintf(out, "%d user(s)\n", n)
	return err
}
