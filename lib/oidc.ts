import { getDb } from "./db";
import crypto from "crypto";

const LEGACY_DEFAULT_OIDC_ENCRYPTION_SECRET = "tubeshelf-default-key-change-me";

declare global {
  // eslint-disable-next-line no-var
  var __tubeshelfOidcEncryptionWarningLogged: boolean | undefined;
}

function getConfiguredEncryptionSecret(): string | null {
  return (
    process.env.OIDC_ENCRYPTION_KEY ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.SECRET_KEY ||
    null
  );
}

function deriveEncryptionKey(secret: string): Buffer {
  return crypto.scryptSync(secret, "tubeshelf-oidc-salt", 32);
}

function warnMissingOIDCEncryptionKeyOnce() {
  if (globalThis.__tubeshelfOidcEncryptionWarningLogged) return;
  globalThis.__tubeshelfOidcEncryptionWarningLogged = true;
  console.warn(
    "[OIDC] No OIDC_ENCRYPTION_KEY/BETTER_AUTH_SECRET configured. Existing legacy OIDC secrets can still be read if they used the historical default key, but creating/updating OIDC providers requires a configured secret."
  );
}

// Encrypt client secret before storing
function encryptSecret(plaintext: string): string {
  const configuredSecret = getConfiguredEncryptionSecret();
  if (!configuredSecret) {
    warnMissingOIDCEncryptionKeyOnce();
    throw new Error(
      "OIDC_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) must be configured before storing OIDC client secrets"
    );
  }
  const key = deriveEncryptionKey(configuredSecret);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:encrypted (all base64)
  return `${iv.toString("base64")}:${authTag.toString(
    "base64"
  )}:${encrypted.toString("base64")}`;
}

// Decrypt client secret when reading
function decryptSecret(ciphertext: string): string {
  // Check if it's already plaintext (for migration from unencrypted)
  if (!ciphertext.includes(":")) {
    return ciphertext;
  }

  const [ivB64, authTagB64, encryptedB64] = ciphertext.split(":");
  if (!ivB64 || !authTagB64 || !encryptedB64) {
    return ciphertext;
  }

  const tryDecryptWithSecret = (secret: string): string | null => {
    try {
      const key = deriveEncryptionKey(secret);
      const iv = Buffer.from(ivB64, "base64");
      const authTag = Buffer.from(authTagB64, "base64");
      const encrypted = Buffer.from(encryptedB64, "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      return null;
    }
  };

  const configuredSecret = getConfiguredEncryptionSecret();
  if (configuredSecret) {
    const decrypted = tryDecryptWithSecret(configuredSecret);
    if (decrypted !== null) {
      return decrypted;
    }
  }

  const legacyDecrypted = tryDecryptWithSecret(LEGACY_DEFAULT_OIDC_ENCRYPTION_SECRET);
  if (legacyDecrypted !== null) {
    console.warn(
      "[OIDC] Decrypted client secret with legacy default key. Configure OIDC_ENCRYPTION_KEY or BETTER_AUTH_SECRET and rotate/re-save the provider secret."
    );
    return legacyDecrypted;
  }

  // If decryption fails, assume it's plaintext (migration case)
  console.warn("[OIDC] Failed to decrypt secret, assuming plaintext");
  return ciphertext;
}

export interface OIDCProvider {
  id: string;
  name: string;
  issuer: string;
  baseUrl?: string;
  discoveryUrl?: string;
  domain?: string;
  redirectUri?: string;
  clientId: string;
  clientSecret: string;
  scopes?: string;
  autoProvision?: boolean;
  groupClaimName?: string;
  adminGroupValue?: string;
  enabled: boolean;
  createdAt: string;
}

export interface OIDCConfig {
  enabled: boolean;
  allowRegistration: boolean;
  providers: OIDCProvider[];
}

// OIDC Provider management
export function getOIDCProviders(
  opts: { includeDisabled?: boolean } = {}
): OIDCProvider[] {
  const db = getDb();
  const providers = db
    .prepare(
      `SELECT 
        id, 
        name, 
        issuer,
        base_url as baseUrl,
        discovery_url as discoveryUrl,
        domain,
        redirect_uri as redirectUri,
        client_id as clientId, 
        client_secret as clientSecret,
        scopes,
        auto_provision as autoProvision,
        group_claim_name as groupClaimName,
        admin_group_value as adminGroupValue,
        enabled, 
        created_at as createdAt 
      FROM oidc_providers 
      WHERE ${opts.includeDisabled ? "1 = 1" : "enabled = 1"} 
        AND client_id IS NOT NULL 
        AND client_id != '' 
        AND client_secret IS NOT NULL 
        AND client_secret != ''`
    )
    .all() as any[];

  return providers.map((p) => ({
    ...p,
    clientSecret: decryptSecret(p.clientSecret),
    autoProvision: p.autoProvision === 1,
  })) as OIDCProvider[];
}

// Get providers for public display (no secrets)
export function getPublicOIDCProviders(): Array<{ id: string; name: string }> {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, name FROM oidc_providers WHERE enabled = 1 AND client_id IS NOT NULL AND client_id != '' AND client_secret IS NOT NULL AND client_secret != ''`
    )
    .all() as Array<{ id: string; name: string }>;
}

// Disabled providers are only visible to admin management (re-enable/edit).
export function getOIDCProvider(
  id: string,
  opts: { includeDisabled?: boolean } = {}
): OIDCProvider | null {
  const db = getDb();
  const provider = db
    .prepare(
      `SELECT 
        id, 
        name, 
        issuer,
        base_url as baseUrl,
        discovery_url as discoveryUrl,
        domain,
        redirect_uri as redirectUri,
        client_id as clientId, 
        client_secret as clientSecret,
        scopes,
        auto_provision as autoProvision,
        group_claim_name as groupClaimName,
        admin_group_value as adminGroupValue,
        enabled, 
        created_at as createdAt 
      FROM oidc_providers 
      WHERE id = ? ${opts.includeDisabled ? "" : "AND enabled = 1"}`
    )
    .get(id) as any | undefined;

  if (!provider) return null;

  // Validate required credentials
  if (!provider.clientId || !provider.clientSecret) {
    console.error(`[OIDC] Provider ${id} is missing client credentials`);
    return null;
  }

  return {
    ...provider,
    clientSecret: decryptSecret(provider.clientSecret),
    autoProvision: provider.autoProvision === 1,
  };
}

export function createOIDCProvider(data: {
  id: string;
  name: string;
  issuer: string;
  baseUrl?: string;
  discoveryUrl?: string;
  domain?: string;
  redirectUri?: string;
  clientId: string;
  clientSecret: string;
  scopes?: string;
  autoProvision?: boolean;
  groupClaimName?: string;
  adminGroupValue?: string;
}): OIDCProvider {
  const db = getDb();

  // Encrypt the client secret before storing
  const encryptedSecret = encryptSecret(data.clientSecret);

  // Use INSERT OR REPLACE to handle case where provider with same ID exists
  db.prepare(
    `INSERT OR REPLACE INTO oidc_providers (
      id, name, issuer, base_url, discovery_url, domain, redirect_uri,
      client_id, client_secret, scopes, auto_provision,
      group_claim_name, admin_group_value, enabled
    ) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.id,
    data.name,
    data.issuer,
    data.baseUrl || null,
    data.discoveryUrl || null,
    data.domain || null,
    data.redirectUri || null,
    data.clientId,
    encryptedSecret,
    data.scopes || "openid profile email groups",
    data.autoProvision ? 1 : 0,
    data.groupClaimName || null,
    data.adminGroupValue || null,
    1 // Enable by default
  );

  // Return the provider with decrypted secret
  return {
    id: data.id,
    name: data.name,
    issuer: data.issuer,
    baseUrl: data.baseUrl,
    discoveryUrl: data.discoveryUrl,
    domain: data.domain,
    redirectUri: data.redirectUri,
    clientId: data.clientId,
    clientSecret: data.clientSecret, // Return original (not encrypted)
    scopes: data.scopes || "openid profile email groups",
    autoProvision: data.autoProvision || false,
    groupClaimName: data.groupClaimName,
    adminGroupValue: data.adminGroupValue,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

export function updateOIDCProvider(
  id: string,
  data: Partial<Omit<OIDCProvider, "id" | "createdAt">>
): void {
  const db = getDb();
  const updates: string[] = [];
  const values: any[] = [];

  if (data.name !== undefined) {
    updates.push("name = ?");
    values.push(data.name);
  }
  if (data.issuer !== undefined) {
    updates.push("issuer = ?");
    values.push(data.issuer);
  }
  if (data.baseUrl !== undefined) {
    updates.push("base_url = ?");
    values.push(data.baseUrl || null);
  }
  if (data.discoveryUrl !== undefined) {
    updates.push("discovery_url = ?");
    values.push(data.discoveryUrl || null);
  }
  if (data.domain !== undefined) {
    updates.push("domain = ?");
    values.push(data.domain || null);
  }
  if (data.redirectUri !== undefined) {
    updates.push("redirect_uri = ?");
    values.push(data.redirectUri || null);
  }
  if (data.clientId !== undefined) {
    updates.push("client_id = ?");
    values.push(data.clientId);
  }
  if (data.clientSecret !== undefined) {
    updates.push("client_secret = ?");
    values.push(encryptSecret(data.clientSecret));
  }
  if (data.scopes !== undefined) {
    updates.push("scopes = ?");
    values.push(data.scopes);
  }
  if (data.autoProvision !== undefined) {
    updates.push("auto_provision = ?");
    values.push(data.autoProvision ? 1 : 0);
  }
  if (data.groupClaimName !== undefined) {
    updates.push("group_claim_name = ?");
    values.push(data.groupClaimName || null);
  }
  if (data.adminGroupValue !== undefined) {
    updates.push("admin_group_value = ?");
    values.push(data.adminGroupValue || null);
  }
  if (data.enabled !== undefined) {
    updates.push("enabled = ?");
    values.push(data.enabled ? 1 : 0);
  }

  if (updates.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE oidc_providers SET ${updates.join(", ")} WHERE id = ?`
  ).run(...values);
}

export function deleteOIDCProvider(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM oidc_providers WHERE id = ?").run(id);
}
