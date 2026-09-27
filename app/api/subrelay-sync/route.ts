import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/apiAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  getSubRelaySyncSettings,
  runSubRelaySync,
  saveSubRelaySyncSettings,
  SubRelaySyncError,
} from "@/lib/subrelaySync";

// Session-only (not reachable with a TubeShelf API key): these routes hold
// and use a SubRelay credential.

export async function GET() {
  const user = await requireSessionUser();
  if (user instanceof NextResponse) return user;
  return NextResponse.json(getSubRelaySyncSettings(user.id));
}

export async function PUT(req: Request) {
  const user = await requireSessionUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    return NextResponse.json(saveSubRelaySyncSettings(user.id, body));
  } catch (err) {
    if (err instanceof SubRelaySyncError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

/** Runs a two-way sync now. */
export async function POST() {
  const user = await requireSessionUser();
  if (user instanceof NextResponse) return user;

  const limit = checkRateLimit({
    bucket: "subrelay-sync-run",
    key: user.id,
    limit: 10,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many syncs. Please try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  try {
    const result = await runSubRelaySync(user.id);
    return NextResponse.json({ result, settings: getSubRelaySyncSettings(user.id) });
  } catch (err) {
    const message = err instanceof SubRelaySyncError ? err.message : "Sync failed";
    return NextResponse.json(
      { error: message, settings: getSubRelaySyncSettings(user.id) },
      { status: 502 }
    );
  }
}
