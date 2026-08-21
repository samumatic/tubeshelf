import { randomUUID } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.TUBESHELF_TEST_DB_PATH = ":memory:";

const { getDb } = await import("./db");
const {
  LOCAL_CREDENTIAL_ISSUER,
  ensureAccountIssuerBackfilled,
  getAuthSecretStatus,
} = await import("./betterAuth");

beforeEach(() => {
  const db = getDb();
  db.exec(
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL)`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS auth_accounts (
      id TEXT NOT NULL PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      issuer TEXT,
      created_at DATE NOT NULL,
      updated_at DATE NOT NULL
    )`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS oidc_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      issuer TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL
    )`
  );

  const tables = ["users", "auth_accounts", "oidc_providers"];
  for (const name of tables) {
    db.exec(`DELETE FROM "${name}"`);
  }
});

function insertAccount(
  providerId: string,
  overrides: Partial<{ userId: string; accountId: string; issuer: string | null }> = {}
) {
  const db = getDb();
  const userId = overrides.userId ?? randomUUID();
  const accountId = overrides.accountId ?? userId;
  db.prepare(
    "INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)"
  ).run(userId, `${userId}@example.com`);
  db.prepare(
    `INSERT INTO auth_accounts (id, account_id, provider_id, user_id, issuer, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(randomUUID(), accountId, providerId, userId, overrides.issuer ?? null);
  return { userId, accountId };
}

describe("ensureAccountIssuerBackfilled", () => {
  it("backfills credential accounts with the well-known local issuer", () => {
    insertAccount("credential");

    ensureAccountIssuerBackfilled();

    const row = getDb()
      .prepare("SELECT issuer FROM auth_accounts WHERE provider_id = 'credential'")
      .get() as { issuer: string };
    expect(row.issuer).toBe(LOCAL_CREDENTIAL_ISSUER);
  });

  it("backfills an OIDC account with its configured provider's issuer URL", () => {
    getDb()
      .prepare(
        "INSERT INTO oidc_providers (id, name, issuer, client_id, client_secret) VALUES ('oidc', 'Pocket ID', 'https://id.example.com', 'client', 'secret')"
      )
      .run();
    insertAccount("oidc");

    ensureAccountIssuerBackfilled();

    const row = getDb()
      .prepare("SELECT issuer FROM auth_accounts WHERE provider_id = 'oidc'")
      .get() as { issuer: string };
    expect(row.issuer).toBe("https://id.example.com");
  });

  it("never overwrites an issuer that is already set", () => {
    insertAccount("credential", { issuer: "some-other-value" });

    ensureAccountIssuerBackfilled();

    const row = getDb()
      .prepare("SELECT issuer FROM auth_accounts WHERE provider_id = 'credential'")
      .get() as { issuer: string };
    expect(row.issuer).toBe("some-other-value");
  });

  it("leaves an OIDC account alone if its provider is no longer configured", () => {
    insertAccount("oidc"); // no matching row in oidc_providers this time

    ensureAccountIssuerBackfilled();

    const row = getDb()
      .prepare("SELECT issuer FROM auth_accounts WHERE provider_id = 'oidc'")
      .get() as { issuer: string | null };
    expect(row.issuer).toBeNull();
  });

  it("is a no-op when every account already has an issuer", () => {
    insertAccount("credential", { issuer: LOCAL_CREDENTIAL_ISSUER });

    expect(() => ensureAccountIssuerBackfilled()).not.toThrow();

    const row = getDb()
      .prepare("SELECT issuer FROM auth_accounts WHERE provider_id = 'credential'")
      .get() as { issuer: string };
    expect(row.issuer).toBe(LOCAL_CREDENTIAL_ISSUER);
  });
});

describe("getAuthSecretStatus", () => {
  const ENV_KEYS = ["BETTER_AUTH_SECRET", "AUTH_SECRET", "SECRET_KEY"] as const;
  const env = process.env as Record<string, string | undefined>;
  let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = env[key];
      delete env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete env[key];
      else env[key] = saved[key];
    }
  });

  it("flags the docker-compose placeholder secret even though it's long enough to pass the length check", () => {
    env.BETTER_AUTH_SECRET = "replace-with-a-random-32+-char-secret";
    const status = getAuthSecretStatus();
    expect(status.length).toBeGreaterThanOrEqual(32);
    expect(status.isTooShort).toBe(false);
    expect(status.isKnownPlaceholder).toBe(true);
  });

  it("does not flag a real random secret of the same length", () => {
    env.BETTER_AUTH_SECRET = "a".repeat(38);
    const status = getAuthSecretStatus();
    expect(status.isKnownPlaceholder).toBe(false);
  });

  it("still flags a too-short secret via isTooShort, independent of the placeholder check", () => {
    env.BETTER_AUTH_SECRET = "short";
    const status = getAuthSecretStatus();
    expect(status.isTooShort).toBe(true);
    expect(status.isKnownPlaceholder).toBe(false);
  });
});
