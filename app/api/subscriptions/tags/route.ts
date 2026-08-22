import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { getDb } from "@/lib/db";

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const channelId =
    typeof body?.channelId === "string" ? body.channelId.trim() : "";
  const tags = Array.isArray(body?.tags)
    ? body.tags.filter((tag: unknown) => typeof tag === "string")
    : [];

  if (!channelId) {
    return NextResponse.json({ error: "channelId is required" }, { status: 400 });
  }

  const db = getDb();
  const current = db
    .prepare("SELECT value FROM user_config WHERE user_id = ? AND key = ?")
    .get(user.id, "subscriptionTags") as { value: string } | undefined;

  let tagMap: Record<string, string[]> = {};
  if (current?.value) {
    try {
      const parsed = JSON.parse(current.value);
      if (parsed && typeof parsed === "object") {
        tagMap = parsed;
      }
    } catch {
      // ignore malformed legacy data
    }
  }

  tagMap[channelId] = tags;

  db.prepare(
    "INSERT OR REPLACE INTO user_config (user_id, key, value) VALUES (?, ?, ?)"
  ).run(user.id, "subscriptionTags", JSON.stringify(tagMap));

  return NextResponse.json({ success: true, channelId, tags });
}
