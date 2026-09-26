import crypto from "crypto";
import { getDb } from "./db";
import { API_KEY_PREFIX } from "./apiKeyHeaders";

export const MAX_API_KEYS_PER_USER = 20;
export const MAX_API_KEY_NAME_LENGTH = 64;
// last_used_at is informational; don't write to the database on every request.
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ApiKeyUser {
  id: string;
  email: string;
  name: string | null;
  oidcProvider: string | null;
}

export class ApiKeyError extends Error {}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey, "utf8").digest("hex");
}

function generateRawKey(): string {
  return `${API_KEY_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

export function normalizeApiKeyName(name: unknown): string {
  const normalized = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  return normalized.slice(0, MAX_API_KEY_NAME_LENGTH);
}

export function listApiKeys(userId: string): ApiKeySummary[] {
  return getDb()
    .prepare(
      `SELECT id, name, key_prefix AS prefix, created_at AS createdAt, last_used_at AS lastUsedAt
       FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(userId) as ApiKeySummary[];
}

/**
 * Creates a key and returns its plaintext exactly once - only the hash is
 * stored, so it can't be shown again.
 */
export function createApiKey(
  userId: string,
  rawName: unknown
): { key: string; apiKey: ApiKeySummary } {
  const name = normalizeApiKeyName(rawName);
  if (!name) {
    throw new ApiKeyError("Key name is required");
  }

  const db = getDb();
  const { count } = db
    .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE user_id = ?")
    .get(userId) as { count: number };
  if (count >= MAX_API_KEYS_PER_USER) {
    throw new ApiKeyError(
      `You can have at most ${MAX_API_KEYS_PER_USER} API keys. Revoke one first.`
    );
  }

  const key = generateRawKey();
  const apiKey: ApiKeySummary = {
    id: crypto.randomUUID(),
    name,
    // Enough to recognize a key in the list without revealing it.
    prefix: key.slice(0, API_KEY_PREFIX.length + 6),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(apiKey.id, userId, name, hashApiKey(key), apiKey.prefix, apiKey.createdAt);

  return { key, apiKey };
}

export function revokeApiKey(userId: string, keyId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?")
    .run(keyId, userId);
  return result.changes > 0;
}

/** Looks up the user a raw API key belongs to, or null if it's unknown. */
export function resolveApiKeyUser(rawKey: string): ApiKeyUser | null {
  if (!rawKey.startsWith(API_KEY_PREFIX)) return null;

  const db = getDb();
  const row = db
    .prepare(
      `SELECT k.id AS keyId, u.id, u.email, u.name, u.oidc_provider AS oidcProvider
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ?`
    )
    .get(hashApiKey(rawKey)) as
    | (ApiKeyUser & { keyId: string })
    | undefined;
  if (!row) return null;

  const now = new Date();
  const staleBefore = new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS).toISOString();
  db.prepare(
    `UPDATE api_keys SET last_used_at = ?
     WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`
  ).run(now.toISOString(), row.keyId, staleBefore);

  return {
    id: String(row.id),
    email: String(row.email),
    name: row.name ?? null,
    oidcProvider: row.oidcProvider ?? null,
  };
}
