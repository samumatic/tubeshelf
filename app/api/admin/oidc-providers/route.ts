import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/apiAuth";
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

export async function GET() {
  const user = await requireAdmin();
  if (user instanceof NextResponse) return user;

  const providers = getOIDCProviders().map(sanitizeProvider);
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

  const existing = getOIDCProvider(id);
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

  updateOIDCProvider(id, updates);
  const updated = getOIDCProvider(id);

  return NextResponse.json({ provider: sanitizeProvider(updated) });
}

export async function DELETE(req: Request) {
  const user = await requireAdmin();
  if (user instanceof NextResponse) return user;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") || "oidc";

  deleteOIDCProvider(id);
  return NextResponse.json({ success: true });
}
