import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/apiAuth";
import {
  ApiKeyError,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "@/lib/apiKeyStore";
import { checkRateLimit } from "@/lib/rateLimit";

export async function GET() {
  const user = await requireSessionUser();
  if (user instanceof NextResponse) return user;

  return NextResponse.json({ apiKeys: listApiKeys(user.id) });
}

export async function POST(req: Request) {
  const user = await requireSessionUser();
  if (user instanceof NextResponse) return user;

  const limit = checkRateLimit({
    bucket: "user-api-key-create",
    key: user.id,
    limit: 20,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many API keys created. Please try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const body = await req.json().catch(() => null);
  try {
    const created = createApiKey(user.id, body?.name);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (err instanceof ApiKeyError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

export async function DELETE(req: Request) {
  const user = await requireSessionUser();
  if (user instanceof NextResponse) return user;

  const id = new URL(req.url).searchParams.get("id")?.trim();
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (!revokeApiKey(user.id, id)) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
