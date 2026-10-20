import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/apiAuth";
import { readSettings } from "@/lib/settingsStore";
import {
  createOIDCProvider,
  deleteOIDCProvider,
  getOIDCProvider,
  getOIDCProviders,
  updateOIDCProvider,
} from "@/lib/oidc";

function sanitizeProvider(provider: any) {
  if (!provider) return provider;
  return {
    ...provider,
    clientSecret: "",
  };
}

// With oidcOnly on, removing the last working provider leaves nobody able to sign in.
async function wouldLockOutLogin(id: string): Promise<boolean> {
  const settings = await readSettings();
  if (!settings.oidcOnly) return false;
  return !getOIDCProviders().some((p) => p.id !== id);
}

const LOCKOUT_MESSAGE =
  "Can't remove or disable the last enabled OIDC provider while OIDC-only login is on. Turn off OIDC-only first.";

export async function GET() {
  const user = await requireAdmin();
  if (user instanceof NextResponse) return user;

  const providers = getOIDCProviders({ includeDisabled: true }).map(sanitizeProvider);
  return NextResponse.json({ providers });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);

  const id = typeof body?.id === "string" && body.id.trim() ? body.id.trim() : "oidc";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const issuer = typeof body?.issuer === "string" ? body.issuer.trim() : "";
  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret =
    typeof body?.clientSecret === "string" ? body.clientSecret : "";

  if (!name || !issuer || !clientId || !clientSecret) {
    return NextResponse.json(
      { error: "name, issuer, clientId and clientSecret are required" },
      { status: 400 }
    );
  }

  const provider = createOIDCProvider({
    id,
    name,
    issuer,
    baseUrl: typeof body?.baseUrl === "string" ? body.baseUrl : undefined,
    discoveryUrl:
      typeof body?.discoveryUrl === "string" ? body.discoveryUrl : undefined,
    domain: typeof body?.domain === "string" ? body.domain : undefined,
    redirectUri:
      typeof body?.redirectUri === "string" ? body.redirectUri : undefined,
    clientId,
    clientSecret,
    scopes: typeof body?.scopes === "string" ? body.scopes : undefined,
    autoProvision: !!body?.autoProvision,
    groupClaimName:
      typeof body?.groupClaimName === "string" ? body.groupClaimName : undefined,
    adminGroupValue:
      typeof body?.adminGroupValue === "string" ? body.adminGroupValue : undefined,
  });

  return NextResponse.json({ provider: sanitizeProvider(provider) });
}

export async function PATCH(req: Request) {
  const user = await requireAdmin();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id.trim() : "";

  if (!id) {
    return NextResponse.json({ error: "Provider id is required" }, { status: 400 });
  }

  const existing = getOIDCProvider(id, { includeDisabled: true });
  if (!existing) {
    return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  }

  const updates: any = {};
  const keys = [
    "name",
    "issuer",
    "baseUrl",
    "discoveryUrl",
    "domain",
    "redirectUri",
    "clientId",
    "scopes",
    "groupClaimName",
    "adminGroupValue",
  ];

  for (const key of keys) {
    if (body && key in body && typeof body[key] === "string") {
      updates[key] = body[key];
    }
  }

  if (body && "autoProvision" in body && typeof body.autoProvision === "boolean") {
    updates.autoProvision = body.autoProvision;
  }

  if (body && "enabled" in body && typeof body.enabled === "boolean") {
    updates.enabled = body.enabled;
  }

  if (
    body &&
    "clientSecret" in body &&
    typeof body.clientSecret === "string" &&
    body.clientSecret.trim().length > 0
  ) {
    updates.clientSecret = body.clientSecret;
  }

  if (updates.enabled === false && (await wouldLockOutLogin(id))) {
    return NextResponse.json({ error: LOCKOUT_MESSAGE }, { status: 400 });
  }

  updateOIDCProvider(id, updates);
  const updated = getOIDCProvider(id, { includeDisabled: true });

  return NextResponse.json({ provider: sanitizeProvider(updated) });
}

export async function DELETE(req: Request) {
  const user = await requireAdmin();
  if (user instanceof NextResponse) return user;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") || "oidc";

  if (await wouldLockOutLogin(id)) {
    return NextResponse.json({ error: LOCKOUT_MESSAGE }, { status: 400 });
  }

  deleteOIDCProvider(id);
  return NextResponse.json({ success: true });
}
