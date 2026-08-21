import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";

const dbPath = path.join(process.cwd(), "data", "tubeshelf.db");

function getDb() {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function normalizeCommand(command) {
  const aliases = {
    "reset-password": "user-reset-password",
    "list-local-users": "user-list",
    "toggle-oidc-only": "oidc-toggle",
    "get-oidc-only": "oidc-status",
  };
  return aliases[command] || command;
}

function randomPassword(length = 16) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

export async function executeCLICommand(args) {
  const [rawCommand, ...rest] = args;
  const command = normalizeCommand(rawCommand);

  if (!command) {
    return {
      success: false,
      message: "No command provided",
    };
  }

  const db = getDb();

  try {
    if (command === "user-list") {
      const users = db
        .prepare(
          `SELECT
             id,
             email,
             name,
             is_admin as isAdmin,
             is_default_admin as isDefaultAdmin,
             oidc_provider as oidcProvider,
             oidc_subject as oidcSubject,
             created_at as createdAt,
             last_login_at as lastLoginAt
           FROM users
           ORDER BY created_at DESC`
        )
        .all();

      return {
        success: true,
        message: `Found ${users.length} user(s)`,
        data: users,
      };
    }

    if (command === "user-reset-password") {
      const email = rest[0]?.trim();
      if (!email) {
        return {
          success: false,
          message: "Usage: user-reset-password <email>",
        };
      }

      const user = db
        .prepare("SELECT id, email, oidc_provider as oidcProvider FROM users WHERE email = ?")
        .get(email);

      if (!user) {
        return {
          success: false,
          message: `User not found: ${email}`,
        };
      }

      const password = randomPassword(16);
      const passwordHash = await bcrypt.hash(password, 12);

      db.exec("BEGIN TRANSACTION");
      try {
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
        const existingCredential = db
          .prepare("SELECT id FROM auth_accounts WHERE user_id = ? AND provider_id = 'credential' LIMIT 1")
          .get(user.id);
        if (existingCredential) {
          db.prepare("UPDATE auth_accounts SET password = ?, updated_at = datetime('now') WHERE id = ?").run(
            passwordHash,
            existingCredential.id
          );
        } else {
          // Must match LOCAL_CREDENTIAL_ISSUER in lib/betterAuth.ts - better-auth's
          // credential sign-in requires this column to be set, or the account can't log in.
          db.prepare(
            `INSERT INTO auth_accounts (
               id, created_at, updated_at, provider_id, account_id, user_id, password, issuer
             ) VALUES (?, datetime('now'), datetime('now'), 'credential', ?, ?, ?, 'local:credential')`
          ).run(crypto.randomBytes(16).toString("hex"), user.id, user.id, passwordHash);
        }
        try {
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
        } catch {
          // Legacy custom session table may not exist on newer installs.
        }
        db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return {
        success: true,
        message: `Password reset successful for ${email}`,
        password,
      };
    }

    if (command === "oidc-status") {
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'oidcOnly' LIMIT 1")
        .get();

      const oidcOnly = row ? JSON.parse(row.value) : false;

      return {
        success: true,
        message: `OIDC-only mode is ${oidcOnly ? "enabled" : "disabled"}`,
        data: {
          oidcOnly,
        },
      };
    }

    if (command === "oidc-toggle") {
      const action = rest[0]?.toLowerCase();
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'oidcOnly' LIMIT 1")
        .get();
      const current = row ? JSON.parse(row.value) : false;

      let next;
      if (action === "enable") {
        next = true;
      } else if (action === "disable") {
        next = false;
      } else {
        next = !current;
      }

      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
        "oidcOnly",
        JSON.stringify(next)
      );

      return {
        success: true,
        message: `OIDC-only mode ${next ? "enabled" : "disabled"}`,
        data: {
          oidcOnly: next,
        },
      };
    }

    return {
      success: false,
      message: `Unknown command: ${rawCommand}`,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}
