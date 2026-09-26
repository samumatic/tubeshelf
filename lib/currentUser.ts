import { cookies, headers } from "next/headers";
import {
  getSessionFromRequest,
  getSessionFromHeaderBag,
  mapBetterAuthUser,
  type AppAuthUser,
} from "./betterAuth";
import { extractApiKey } from "./apiKeyHeaders";
import { resolveApiKeyUser } from "./apiKeyStore";

export interface CurrentUser extends AppAuthUser {
  /** True when the request authenticated with an API key, not a session. */
  viaApiKey?: boolean;
}

/**
 * Resolves an API key the request presents. Returns undefined when it
 * presents none (fall through to session auth) and null when the key is
 * unknown - an explicit credential that fails must not fall back to cookies.
 *
 * API-key users are never admins, regardless of the account's role: keys are
 * meant for syncing subscriptions, not for administering the instance.
 */
function userFromApiKey(headerBag: Headers): CurrentUser | null | undefined {
  const rawKey = extractApiKey(headerBag);
  if (!rawKey) return undefined;

  const keyUser = resolveApiKeyUser(rawKey);
  if (!keyUser) return null;

  return {
    id: keyUser.id,
    email: keyUser.email,
    name: keyUser.name,
    isAdmin: false,
    isDefaultAdmin: false,
    oidcProvider: keyUser.oidcProvider,
    authType: keyUser.oidcProvider ? "oidc" : "local",
    viaApiKey: true,
  };
}

function firstHeaderValue(value: string | null): string {
  if (!value) return "";
  return value.split(",")[0]?.trim() || "";
}

function inferRequestUrlFromHeaders(headerBag: Headers): string {
  const forwardedHost = firstHeaderValue(headerBag.get("x-forwarded-host"));
  const forwardedProto = firstHeaderValue(headerBag.get("x-forwarded-proto"));
  const host = forwardedHost || firstHeaderValue(headerBag.get("host")) || "localhost";
  const proto = forwardedProto || "http";
  return `${proto}://${host}/`;
}

export async function getCurrentUser(
  request?: Request
): Promise<CurrentUser | null> {
  if (request) {
    const apiKeyUser = userFromApiKey(request.headers);
    if (apiKeyUser !== undefined) return apiKeyUser;

    const session = await getSessionFromRequest(request);
    return mapBetterAuthUser(session?.user);
  }

  const headerStore = await headers();
  const headerBag = new Headers(headerStore);

  const apiKeyUser = userFromApiKey(headerBag);
  if (apiKeyUser !== undefined) return apiKeyUser;

  if (!headerBag.get("cookie")) {
    const cookieStore = await cookies();
    const cookieHeader = cookieStore
      .getAll()
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    if (cookieHeader) {
      headerBag.set("cookie", cookieHeader);
    }
  }

  const syntheticRequest = new Request(inferRequestUrlFromHeaders(headerBag), {
    headers: headerBag,
  });
  const session = await getSessionFromRequest(syntheticRequest);
  if (session?.user) {
    return mapBetterAuthUser(session.user);
  }

  // Final fallback for environments where constructing a synthetic request is insufficient.
  const legacySession = await getSessionFromHeaderBag(headerBag);
  return mapBetterAuthUser(legacySession?.user);
}
