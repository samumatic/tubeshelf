import crypto from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import {
  genericOAuth,
  type GenericOAuthConfig,
} from "better-auth/plugins/generic-oauth";
import { decodeJwt } from "jose";
import { getDb, repairBrokenUserForeignKeys } from "@/lib/db";
import { shouldUseSecureCookies } from "@/lib/cookieSecurity";
import {
  getOIDCProvider,
  getOIDCProviders,
  type OIDCProvider,
} from "@/lib/oidc";

const BCRYPT_ROUNDS = 12;
// better-auth 1.7+ requires every account row to carry an `issuer` - a stable
// namespace it uses to tell apart accounts from different providers that
// might otherwise collide (e.g. two providers both using numeric IDs). It
// computes this itself for local credential accounts as
// `local:${encodeURIComponent(providerId)}`; mirrored here so backfilled rows
// match exactly what better-auth writes for new ones.
export const LOCAL_CREDENTIAL_ISSUER = "local:credential";
// Sessions last 3 months and are refreshed on use (see SESSION_UPDATE_AGE_SECONDS),
// so an account that is opened at least once a month effectively stays signed in.
const SESSION_DURATION_SECONDS = 90 * 24 * 60 * 60;
// How stale a session may get before BetterAuth extends its expiry (and re-sends
// the cookie). Daily is frequent enough to keep regular users signed in forever
// without writing to auth_sessions on every request.
const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;
const GENERATED_BETTER_AUTH_SECRET_FILE = path.join(
  process.cwd(),
  "data",
  ".better-auth-secret",
);
const BETTER_AUTH_MIGRATION_WARNINGS_TO_SUPPRESS = [
  "Field created_at in table users has a different type in the database. Expected date but got TEXT.",
  "Field updated_at in table users has a different type in the database. Expected date but got TEXT.",
  "Field last_login_at in table users has a different type in the database. Expected date but got TEXT.",
];

type BetterAuthSession = Awaited<
  ReturnType<ReturnType<typeof createAuth>["api"]["getSession"]>
>;

declare global {
  // eslint-disable-next-line no-var
  var __tubeshelfBetterAuthReadyPromise: Promise<void> | undefined;
  // eslint-disable-next-line no-var
  var __tubeshelfAuthSecretWarningLogged: boolean | undefined;
}

type AuthSecretSource =
  | "BETTER_AUTH_SECRET"
  | "AUTH_SECRET"
  | "SECRET_KEY"
  | "generated-file"
  | "generated-memory";

type AuthSecretStatus = {
  source: AuthSecretSource;
  isGeneratedFallback: boolean;
  isTooShort: boolean;
  isKnownPlaceholder: boolean;
  length: number;
};

// The literal placeholder shipped in docker-compose.yml, docker-compose.local.yml,
// and the README quick-start snippet. Long enough to pass the length check, so it
// needs its own explicit detection - an operator who deploys the compose file
// unedited must not sail through silently.
const KNOWN_PLACEHOLDER_AUTH_SECRETS = new Set([
  "replace-with-a-random-32+-char-secret",
]);

function generateRandomSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

function readPersistedGeneratedAuthSecret():
  | { secret: string; source: "generated-file" }
  | { secret: string; source: "generated-memory" } {
  try {
    if (existsSync(GENERATED_BETTER_AUTH_SECRET_FILE)) {
      const existing = readFileSync(
        GENERATED_BETTER_AUTH_SECRET_FILE,
        "utf8",
      ).trim();
      if (existing) {
        return { secret: existing, source: "generated-file" };
      }
    }

    const dataDir = path.dirname(GENERATED_BETTER_AUTH_SECRET_FILE);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    }

    const generated = generateRandomSecret();
    try {
      writeFileSync(GENERATED_BETTER_AUTH_SECRET_FILE, `${generated}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return { secret: generated, source: "generated-file" };
    } catch (writeError: any) {
      if (writeError?.code === "EEXIST") {
        const existing = readFileSync(
          GENERATED_BETTER_AUTH_SECRET_FILE,
          "utf8",
        ).trim();
        if (existing) {
          return { secret: existing, source: "generated-file" };
        }
      }
      console.warn(
        `[Auth] Failed to persist generated BetterAuth secret at ${GENERATED_BETTER_AUTH_SECRET_FILE}. Using in-memory secret for this process only.`,
        writeError,
      );
      return { secret: generated, source: "generated-memory" };
    }
  } catch (error) {
    const generated = generateRandomSecret();
    console.warn(
      `[Auth] Failed to load or create BetterAuth secret fallback file at ${GENERATED_BETTER_AUTH_SECRET_FILE}. Using in-memory secret for this process only.`,
      error,
    );
    return { secret: generated, source: "generated-memory" };
  }
}

function resolveAuthSecret(): { secret: string; status: AuthSecretStatus } {
  const envSecret =
    process.env.BETTER_AUTH_SECRET ??
    process.env.AUTH_SECRET ??
    process.env.SECRET_KEY;

  let secret: string;
  let source: AuthSecretSource;

  if (envSecret) {
    secret = envSecret;
    source = process.env.BETTER_AUTH_SECRET
      ? "BETTER_AUTH_SECRET"
      : process.env.AUTH_SECRET
        ? "AUTH_SECRET"
        : "SECRET_KEY";
  } else {
    const generated = readPersistedGeneratedAuthSecret();
    secret = generated.secret;
    source = generated.source;
  }

  const length = secret.length;
  return {
    secret,
    status: {
      source,
      isGeneratedFallback:
        source === "generated-file" || source === "generated-memory",
      isTooShort: length < 32,
      isKnownPlaceholder: KNOWN_PLACEHOLDER_AUTH_SECRETS.has(secret),
      length,
    },
  };
}

function warnIfAuthSecretIsInsecure() {
  const { status } = resolveAuthSecret();
  if (
    !status.isGeneratedFallback &&
    !status.isTooShort &&
    !status.isKnownPlaceholder
  )
    return;
  if (globalThis.__tubeshelfAuthSecretWarningLogged) return;
  globalThis.__tubeshelfAuthSecretWarningLogged = true;

  if (status.isGeneratedFallback) {
    console.warn(
      "[Auth] No BETTER_AUTH_SECRET is configured. Using an auto-generated instance-local BetterAuth secret. Set BETTER_AUTH_SECRET (32+ chars) for portability and multi-instance deployments. Changing the secret will invalidate BetterAuth sessions.",
    );
    if (!status.isTooShort && !status.isKnownPlaceholder) return;
  }

  if (status.isKnownPlaceholder) {
    console.warn(
      "[Auth] BETTER_AUTH_SECRET is still set to the docker-compose placeholder value. This secret is public (it's in the repo) and is shared by every instance that didn't change it - sessions and any OIDC client secrets encrypted with it are not safe. Set BETTER_AUTH_SECRET to a unique random value, e.g. `openssl rand -base64 32`.",
    );
    return;
  }

  console.warn(
    `[Auth] BetterAuth secret from ${status.source} is only ${status.length} chars. Use BETTER_AUTH_SECRET with at least 32 characters.`,
  );
}

export function getAuthSecretStatus() {
  const { status } = resolveAuthSecret();
  return status;
}

function firstHeaderValue(value: string | null): string {
  if (!value) return "";
  return value.split(",")[0]?.trim() || "";
}

function getRequestBaseUrl(request?: Request): string | undefined {
  if (!request) {
    return process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL;
  }

  const url = new URL(request.url);
  const forwardedHost = firstHeaderValue(
    request.headers.get("x-forwarded-host"),
  );
  const forwardedProto = firstHeaderValue(
    request.headers.get("x-forwarded-proto"),
  );

  if (forwardedHost) {
    const proto = forwardedProto || url.protocol.replace(":", "");
    return `${proto}://${forwardedHost}`;
  }

  return `${url.protocol}//${url.host}`;
}

function parseScopes(scopes?: string | null): string[] | undefined {
  if (!scopes) return undefined;
  const parsed = scopes
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length ? parsed : undefined;
}

function computeAdminFromClaims(
  provider: Pick<OIDCProvider, "groupClaimName" | "adminGroupValue">,
  claims: Record<string, unknown>,
): boolean | null {
  if (!provider.groupClaimName || !provider.adminGroupValue) return null;

  const raw = claims[provider.groupClaimName];
  if (raw == null) return false;

  const values = Array.isArray(raw) ? raw : [raw];
  return values.map(String).includes(provider.adminGroupValue);
}

function redirectUriForProvider(
  baseUrl: string,
  provider: OIDCProvider,
): string {
  return provider.redirectUri || `${baseUrl}/api/auth/oidc/callback`;
}

function toGenericOAuthConfig(
  baseUrl: string,
  provider: OIDCProvider,
): GenericOAuthConfig {
  return {
    providerId: provider.id,
    discoveryUrl:
      provider.discoveryUrl ||
      `${provider.issuer}/.well-known/openid-configuration`,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    scopes: parseScopes(provider.scopes) || [
      "openid",
      "profile",
      "email",
      "groups",
    ],
    redirectURI: redirectUriForProvider(baseUrl, provider),
    // Keep sign-up behavior compatible with the current implementation (OIDC auto-provisions users).
    disableImplicitSignUp: false,
    disableSignUp: false,
    mapProfileToUser: async (profile) => {
      const oidcSubject =
        typeof profile.sub === "string"
          ? profile.sub
          : typeof profile.id === "string"
            ? profile.id
            : undefined;
      const isAdmin = computeAdminFromClaims(
        provider,
        profile as Record<string, unknown>,
      );

      return {
        name:
          (typeof profile.name === "string" && profile.name) ||
          (typeof profile.preferred_username === "string" &&
            profile.preferred_username) ||
          undefined,
        oidcProvider: provider.id,
        oidcSubject,
        ...(isAdmin === null ? {} : { isAdmin }),
      };
    },
  };
}

function syncAccountBackToLegacyFields(account: Record<string, any>) {
  const db = getDb();
  const providerId =
    typeof account.providerId === "string" ? account.providerId : "";
  const userId = typeof account.userId === "string" ? account.userId : "";
  if (!providerId || !userId) return;

  if (providerId === "credential") {
    if (typeof account.password === "string") {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
        account.password,
        userId,
      );
    }
    return;
  }

  let isAdminUpdate: boolean | null = null;
  if (typeof account.idToken === "string" && account.idToken) {
    try {
      const provider = getOIDCProvider(providerId);
      if (provider) {
        const claims = decodeJwt(account.idToken) as Record<string, unknown>;
        isAdminUpdate = computeAdminFromClaims(provider, claims);
      }
    } catch {
      // Ignore token decode failures and keep existing admin flag.
    }
  }

  if (isAdminUpdate === null) {
    db.prepare(
      "UPDATE users SET oidc_provider = COALESCE(oidc_provider, ?), oidc_subject = COALESCE(oidc_subject, ?) WHERE id = ?",
    ).run(providerId, account.accountId || null, userId);
    return;
  }

  db.prepare(
    "UPDATE users SET oidc_provider = ?, oidc_subject = ?, is_admin = ? WHERE id = ?",
  ).run(providerId, account.accountId || null, isAdminUpdate ? 1 : 0, userId);
}

function migrateUsersDateFields() {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{
    name: string;
    type: string;
  }>;

  if (columns.length === 0) return;

  const needsMigration = ["created_at", "updated_at", "last_login_at"].some(
    (col) => {
      const column = columns.find((c) => c.name === col);
      return !column || column.type.toUpperCase() !== "DATE";
    },
  );

  if (!needsMigration) return;

  console.log(
    "[Migration] Converting users date fields to DATE type to satisfy BetterAuth",
  );

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    // Clean up any leftover users_old from failed previous migration
    db.exec("DROP TABLE IF EXISTS users_old");

    db.exec("ALTER TABLE users RENAME TO users_old");

    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        password_hash TEXT,
        oidc_provider TEXT,
        oidc_subject TEXT,
        created_at DATE NOT NULL DEFAULT (datetime('now')),
        last_login_at DATE,
        updated_at DATE,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_default_admin INTEGER NOT NULL DEFAULT 0,
        email_verified INTEGER NOT NULL DEFAULT 1,
        image TEXT
      );
    `);

    db.exec(`
      INSERT INTO users (
        id, email, name, password_hash, oidc_provider, oidc_subject,
        created_at, last_login_at, updated_at, is_admin, is_default_admin,
        email_verified, image
      )
      SELECT
        id, email, name, password_hash, oidc_provider, oidc_subject,
        created_at, last_login_at,
        COALESCE(updated_at, created_at),
        is_admin, is_default_admin,
        COALESCE(email_verified, 1),
        image
      FROM users_old;
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_oidc ON users(oidc_provider, oidc_subject);
    `);

    db.exec("DROP TABLE users_old");
  } catch (error) {
    console.error("[Migration] Failed to migrate users date fields:", error);
    // Try to restore the original table if possible
    try {
      const hasUsersOld = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='users_old'",
        )
        .get();
      const hasUsers = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
        )
        .get();
      if (hasUsersOld && !hasUsers) {
        db.exec("ALTER TABLE users_old RENAME TO users");
      }
    } catch (restoreError) {
      console.error("[Migration] Failed to restore users table:", restoreError);
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function ensureUserColumns() {
  const db = getDb();

  // Clean up any leftover corrupted tables from failed migrations
  db.exec("DROP TABLE IF EXISTS users_old");

  migrateUsersDateFields();

  const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((c) => c.name));

  if (columns.length === 0) {
    console.log(
      "[Migration] Users table missing, recreating with correct schema",
    );
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        password_hash TEXT,
        oidc_provider TEXT,
        oidc_subject TEXT,
        created_at DATE NOT NULL DEFAULT (datetime('now')),
        last_login_at DATE,
        updated_at DATE,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_default_admin INTEGER NOT NULL DEFAULT 0,
        email_verified INTEGER NOT NULL DEFAULT 1,
        image TEXT
      );
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_oidc ON users(oidc_provider, oidc_subject);
    `);
    return;
  }

  if (!names.has("updated_at")) {
    db.exec("ALTER TABLE users ADD COLUMN updated_at DATE");
  }
  if (!names.has("email_verified")) {
    db.exec(
      "ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1",
    );
  }
  if (!names.has("image")) {
    db.exec("ALTER TABLE users ADD COLUMN image TEXT");
  }

  db.exec(`
    UPDATE users
    SET
      updated_at = COALESCE(updated_at, created_at),
      email_verified = COALESCE(email_verified, 1)
    WHERE updated_at IS NULL OR email_verified IS NULL
  `);
}

function ensureLegacyAccountsBackfilled() {
  const db = getDb();

  const hasAuthAccounts = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='auth_accounts'",
    )
    .get() as { name: string } | undefined;

  if (!hasAuthAccounts) return;

  const users = db
    .prepare(
      `SELECT id, password_hash as passwordHash, oidc_provider as oidcProvider, oidc_subject as oidcSubject, created_at as createdAt
       FROM users`,
    )
    .all() as Array<{
    id: string;
    passwordHash: string | null;
    oidcProvider: string | null;
    oidcSubject: string | null;
    createdAt: string | null;
  }>;

  const insertCredential = db.prepare(
    `INSERT INTO auth_accounts (
      id, created_at, updated_at, provider_id, account_id, user_id, password, issuer
    ) VALUES (?, ?, ?, 'credential', ?, ?, ?, '${LOCAL_CREDENTIAL_ISSUER}')`,
  );
  const insertOidc = db.prepare(
    `INSERT INTO auth_accounts (
      id, created_at, updated_at, provider_id, account_id, user_id, issuer
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const hasCredential = db.prepare(
    `SELECT 1 FROM auth_accounts WHERE user_id = ? AND provider_id = 'credential' LIMIT 1`,
  );
  const hasProviderAccount = db.prepare(
    `SELECT 1 FROM auth_accounts WHERE user_id = ? AND provider_id = ? AND account_id = ? LIMIT 1`,
  );

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const user of users) {
      const createdAt = user.createdAt || now;

      if (user.passwordHash && !hasCredential.get(user.id)) {
        insertCredential.run(
          crypto.randomBytes(16).toString("hex"),
          createdAt,
          createdAt,
          user.id,
          user.id,
          user.passwordHash,
        );
      }

      if (user.oidcProvider && user.oidcSubject) {
        if (
          !hasProviderAccount.get(user.id, user.oidcProvider, user.oidcSubject)
        ) {
          insertOidc.run(
            crypto.randomBytes(16).toString("hex"),
            createdAt,
            createdAt,
            user.oidcProvider,
            user.oidcSubject,
            user.id,
            getOIDCProvider(user.oidcProvider)?.issuer ?? null,
          );
        }
      }
    }
  });

  tx();
}

/**
 * Backfill `issuer` on account rows written before better-auth 1.7 added it.
 * better-auth matches a sign-in attempt's credential account by
 * `issuer === createLocalAccountIssuer(providerId)`, so a row missing this
 * value never matches and every existing local-password user is locked out
 * silently ("User not found") even though the row is otherwise intact.
 */
export function ensureAccountIssuerBackfilled() {
  const db = getDb();

  const hasAuthAccounts = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='auth_accounts'",
    )
    .get() as { name: string } | undefined;

  if (!hasAuthAccounts) return;

  const columns = db.pragma("table_info(auth_accounts)") as Array<{
    name: string;
  }>;
  if (!columns.some((c) => c.name === "issuer")) {
    db.exec("ALTER TABLE auth_accounts ADD COLUMN issuer TEXT");
  }

  const missing = db
    .prepare(
      "SELECT COUNT(*) as count FROM auth_accounts WHERE issuer IS NULL",
    )
    .get() as { count: number };
  if (missing.count === 0) return;

  console.log(
    `[Migration] Backfilling issuer for ${missing.count} account(s)`,
  );

  db.prepare(
    "UPDATE auth_accounts SET issuer = ? WHERE provider_id = 'credential' AND issuer IS NULL",
  ).run(LOCAL_CREDENTIAL_ISSUER);

  const updateProviderIssuer = db.prepare(
    "UPDATE auth_accounts SET issuer = ? WHERE provider_id = ? AND issuer IS NULL",
  );
  for (const provider of getOIDCProviders()) {
    if (provider.issuer) {
      updateProviderIssuer.run(provider.issuer, provider.id);
    }
  }
}

function ensureBetterAuthTables() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_accounts (
      id TEXT NOT NULL PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at DATE,
      refresh_token_expires_at DATE,
      scope TEXT,
      password TEXT,
      issuer TEXT,
      created_at DATE NOT NULL,
      updated_at DATE NOT NULL
    );

    CREATE INDEX IF NOT EXISTS auth_accounts_user_id_idx
    ON auth_accounts(user_id);

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT NOT NULL PRIMARY KEY,
      expires_at DATE NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at DATE NOT NULL,
      updated_at DATE NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx
    ON auth_sessions(user_id);

    CREATE TABLE IF NOT EXISTS auth_verifications (
      id TEXT NOT NULL PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at DATE NOT NULL,
      created_at DATE NOT NULL,
      updated_at DATE NOT NULL
    );

    CREATE INDEX IF NOT EXISTS auth_verifications_identifier_idx
    ON auth_verifications(identifier);
  `);
}

async function initBetterAuthSchema() {
  ensureUserColumns();
  repairBrokenUserForeignKeys();
  ensureBetterAuthTables();

  const auth = createAuth();

  // Skip better-auth built-in migrations since we handle schema manually
  // to avoid conflicts with SQLite foreign key constraints during table renames

  ensureAccountIssuerBackfilled();
  ensureLegacyAccountsBackfilled();
}

export async function ensureBetterAuthReady() {
  if (!globalThis.__tubeshelfBetterAuthReadyPromise) {
    globalThis.__tubeshelfBetterAuthReadyPromise = initBetterAuthSchema().catch(
      (error) => {
        globalThis.__tubeshelfBetterAuthReadyPromise = undefined;
        throw error;
      },
    );
  }

  await globalThis.__tubeshelfBetterAuthReadyPromise;
}

function createAuth(request?: Request) {
  warnIfAuthSecretIsInsecure();
  const baseUrl = getRequestBaseUrl(request) || "http://localhost:3000";
  const oidcConfigs = getOIDCProviders().map((provider) =>
    toGenericOAuthConfig(baseUrl, provider),
  );

  return betterAuth({
    appName: "TubeShelf",
    baseURL: baseUrl,
    basePath: "/api/auth",
    secret: resolveAuthSecret().secret,
    trustedProxyHeaders: true,
    database: getDb(),
    advanced: {
      useSecureCookies: shouldUseSecureCookies(request),
      cookies: {
        session_token: {
          name: "session",
          attributes: {
            maxAge: SESSION_DURATION_SECONDS,
            sameSite: "lax",
            path: "/",
            httpOnly: true,
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      password: {
        hash: (password) => bcrypt.hash(password, BCRYPT_ROUNDS),
        verify: ({ password, hash }) => bcrypt.compare(password, hash),
      },
    },
    user: {
      modelName: "users",
      fields: {
        createdAt: "created_at",
        updatedAt: "updated_at",
        emailVerified: "email_verified",
      },
      additionalFields: {
        isAdmin: {
          type: "boolean",
          fieldName: "is_admin",
          defaultValue: false,
        },
        isDefaultAdmin: {
          type: "boolean",
          fieldName: "is_default_admin",
          defaultValue: false,
        },
        oidcProvider: {
          type: "string",
          fieldName: "oidc_provider",
          required: false,
        },
        oidcSubject: {
          type: "string",
          fieldName: "oidc_subject",
          required: false,
        },
        lastLoginAt: {
          type: "date",
          fieldName: "last_login_at",
          required: false,
          input: false,
        },
      },
    },
    session: {
      modelName: "auth_sessions",
      fields: {
        createdAt: "created_at",
        updatedAt: "updated_at",
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
      },
      expiresIn: SESSION_DURATION_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    account: {
      modelName: "auth_accounts",
      fields: {
        createdAt: "created_at",
        updatedAt: "updated_at",
        providerId: "provider_id",
        accountId: "account_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        issuer: "issuer",
      },
      // Without this, a first-time OIDC login whose claimed email matches an
      // existing local-password account gets silently linked to (and signed in
      // as) that account - full takeover by anyone who can register that email
      // on the IdP, since no provider is configured as `trustedProviders` and
      // every local user has `email_verified` hardcoded to 1. TubeShelf has no
      // in-app "link account" flow that relies on implicit linking, so this
      // only closes the hole; it doesn't disable OIDC auto-provisioning of new
      // users, and it doesn't affect an OIDC identity that's already linked.
      accountLinking: {
        enabled: false,
      },
    },
    verification: {
      modelName: "auth_verifications",
      fields: {
        createdAt: "created_at",
        updatedAt: "updated_at",
        expiresAt: "expires_at",
      },
    },
    plugins: oidcConfigs.length ? [genericOAuth({ config: oidcConfigs })] : [],
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            getDb()
              .prepare(
                "UPDATE users SET last_login_at = datetime('now') WHERE id = ?",
              )
              .run(session.userId);
          },
        },
      },
      account: {
        create: {
          after: async (account) => {
            syncAccountBackToLegacyFields(account as Record<string, any>);
          },
        },
        update: {
          after: async (account) => {
            syncAccountBackToLegacyFields(account as Record<string, any>);
          },
        },
      },
    },
  });
}

export async function getAuth(request?: Request) {
  await ensureBetterAuthReady();
  return createAuth(request);
}

export type AppAuthUser = {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  isDefaultAdmin: boolean;
  oidcProvider: string | null;
  authType: "local" | "oidc";
};

export function mapBetterAuthUser(
  user: Record<string, any> | null | undefined,
): AppAuthUser | null {
  if (!user) return null;

  const oidcProvider =
    typeof user.oidcProvider === "string" ? user.oidcProvider : null;

  return {
    id: String(user.id),
    email: String(user.email),
    name: typeof user.name === "string" ? user.name : null,
    isAdmin: !!user.isAdmin,
    isDefaultAdmin: !!user.isDefaultAdmin,
    oidcProvider,
    authType: oidcProvider ? "oidc" : "local",
  };
}

export async function getSessionFromRequest(request: Request) {
  const auth = await getAuth(request);
  return auth.api.getSession({ headers: request.headers });
}

export async function getSessionFromHeaderBag(headerBag: Headers) {
  const auth = await getAuth();
  return auth.api.getSession({ headers: headerBag });
}

export function appendSetCookieHeaders(
  target: Headers,
  source?: Headers | null,
) {
  if (!source) return;
  source.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      target.append(key, value);
      return;
    }
    target.set(key, value);
  });
}

export function getBetterAuthProviderCookieName() {
  return "oidc_provider";
}
