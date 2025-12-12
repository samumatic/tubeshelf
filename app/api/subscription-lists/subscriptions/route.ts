import { NextResponse } from "next/server";
import {
  readLists,
  addSubscriptionToList,
  removeSubscriptionFromList,
  clearListSubscriptions,
  clearAllSubscriptions,
} from "@/lib/subscriptionListStore";
import { fetchChannelFeed } from "@/lib/rss";
import { resolveChannelId } from "@/lib/rss";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const { listId, input } = body || {};

  if (!listId || !input) {
    return NextResponse.json(
      { error: "List ID and input required" },
      { status: 400 }
    );
  }

  try {
    const channelId = await resolveChannelId(input);
    if (!channelId) {
      return NextResponse.json(
        { error: "Could not parse channel ID from input" },
        { status: 400 }
      );
    }

    const { meta } = await fetchChannelFeed(channelId);
    const subscription = {
      id: channelId,
      channelId,
      title: meta.title || channelId,
      url: `https://www.youtube.com/channel/${channelId}`,
      thumbnail: meta.thumbnail,
      addedAt: new Date().toISOString(),
    };

    await addSubscriptionToList(listId, subscription);
    const lists = await readLists();
    const list = lists.lists.find((l) => l.id === listId);
    return NextResponse.json(list);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to add subscription" },
      { status: 400 }
    );
  }
}

export async function DELETE(req: Request) {
  const body = await req.json().catch(() => null);
  const { action, channelId, listId } = body || {};

  // Handle clear actions (delete all or from specific list)
  if (action === "clear") {
    try {
      if (listId) {
        // Clear subscriptions from specific list
        await clearListSubscriptions(listId);
      } else {
        // Clear all subscriptions from all lists
        await clearAllSubscriptions();
      }
      const lists = await readLists();
      return NextResponse.json(lists);
    } catch (err: any) {
      return NextResponse.json(
        { error: err?.message || "Failed to clear subscriptions" },
        { status: 400 }
      );
    }
  }

  // Handle removing a single subscription
  const listIdParam = listId || new URL(req.url).searchParams.get("listId");
  const channelIdParam =
    channelId || new URL(req.url).searchParams.get("channelId");

  if (!listIdParam || !channelIdParam) {
    return NextResponse.json(
      { error: "List ID and channel ID required" },
      { status: 400 }
    );
  }

  try {
    await removeSubscriptionFromList(listIdParam, channelIdParam);
    const lists = await readLists();
    return NextResponse.json(lists);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to remove subscription" },
      { status: 400 }
    );
  }
}
