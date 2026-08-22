import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { resolveChannelId, fetchChannelFeed } from "@/lib/videoFetcher";
import {
  addSubscriptionToList,
  readLists,
  removeSubscriptionFromList,
  type SubscriptionInList,
} from "@/lib/subscriptionListStore";

function getDefaultListId(userId: string) {
  return `default-${userId}`;
}

function dedupeSubscriptionsByChannel(
  lists: Array<{ subscriptions: SubscriptionInList[] }>
): SubscriptionInList[] {
  const seen = new Set<string>();
  const result: SubscriptionInList[] = [];

  for (const list of lists) {
    for (const sub of list.subscriptions) {
      if (seen.has(sub.channelId)) continue;
      seen.add(sub.channelId);
      result.push(sub);
    }
  }

  return result;
}

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const listsData = await readLists(user.id);
  const subs = dedupeSubscriptionsByChannel(listsData.lists);
  return NextResponse.json(subs);
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  const input = body?.input as string | undefined;
  if (!input || typeof input !== "string") {
    return NextResponse.json({ error: "Input required" }, { status: 400 });
  }

  const channelId = await resolveChannelId(input);
  if (!channelId) {
    console.error("Failed to resolve channel ID from input", { input });
    return NextResponse.json(
      { error: "Could not parse channel ID from input" },
      { status: 400 }
    );
  }

  const listsData = await readLists(user.id);
  const existing = dedupeSubscriptionsByChannel(listsData.lists);
  if (existing.some((s) => s.channelId === channelId)) {
    return NextResponse.json({ error: "Already subscribed" }, { status: 409 });
  }

  try {
    const { meta } = await fetchChannelFeed(channelId);
    const newSub: SubscriptionInList = {
      id: channelId,
      channelId,
      title: meta.title || channelId,
      thumbnail: meta.thumbnail,
      url: `https://www.youtube.com/channel/${channelId}`,
      addedAt: new Date().toISOString(),
    };

    await addSubscriptionToList(getDefaultListId(user.id), newSub, user.id);
    return NextResponse.json(newSub, { status: 201 });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to subscribe" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const id = url.searchParams.get("id") || url.searchParams.get("channelId");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const listsData = await readLists(user.id);
  let removed = 0;

  for (const list of listsData.lists) {
    const matches = list.subscriptions.filter(
      (s) => s.channelId === id || s.id === id
    );
    if (matches.length === 0) continue;
    for (const match of matches) {
      await removeSubscriptionFromList(list.id, match.channelId, user.id);
      removed += 1;
    }
  }

  return NextResponse.json({ ok: true, removed });
}
