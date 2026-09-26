// Header parsing for API-key requests. Kept free of database imports so the
// request proxy can use it cheaply on every request.

export const API_KEY_PREFIX = "tsk_";

/**
 * API routes an API key may call. Keys are for syncing subscriptions from
 * other tools (e.g. SubRelay), so they deliberately can't reach account,
 * settings, admin, or danger-zone routes - including key management itself,
 * so a leaked key can't mint more keys.
 */
export const API_KEY_ALLOWED_PATHS = [
  "/api/subscriptions",
  "/api/subscription-lists",
];

/**
 * Returns the API key a request presents, or null if it presents none.
 * Accepts `X-API-Key: <key>` or `Authorization: Bearer tsk_...`; other
 * Bearer tokens are ignored so they never get mistaken for an API key.
 */
export function extractApiKey(headers: Headers): string | null {
  const headerKey = headers.get("x-api-key")?.trim();
  if (headerKey) return headerKey;

  const authorization = headers.get("authorization")?.trim() || "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (match && match[1].startsWith(API_KEY_PREFIX)) {
    return match[1];
  }
  return null;
}

export function isApiKeyAllowedPath(pathname: string): boolean {
  return API_KEY_ALLOWED_PATHS.some(
    (allowed) => pathname === allowed || pathname.startsWith(`${allowed}/`)
  );
}
