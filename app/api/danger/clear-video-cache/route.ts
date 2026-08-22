import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { readLists } from "@/lib/subscriptionListStore";
import { clearVideoCacheForChannels } from "@/lib/videoCacheStore";

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const { lists } = await readLists(user.id);
  const channelIds = Array.from(
    new Set(lists.flatMap((list) => list.subscriptions.map((s) => s.channelId)))
  );

  const result = clearVideoCacheForChannels(channelIds);
  return NextResponse.json({ success: true, ...result });
}
