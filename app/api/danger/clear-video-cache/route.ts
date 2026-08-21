import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/currentUser";
import { readLists } from "@/lib/subscriptionListStore";
import { clearVideoCacheForChannels } from "@/lib/videoCacheStore";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { lists } = await readLists(user.id);
  const channelIds = Array.from(
    new Set(lists.flatMap((list) => list.subscriptions.map((s) => s.channelId)))
  );

  const result = clearVideoCacheForChannels(channelIds);
  return NextResponse.json({ success: true, ...result });
}
