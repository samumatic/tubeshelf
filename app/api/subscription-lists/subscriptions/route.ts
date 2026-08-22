import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { resolveChannelId, fetchChannelFeed } from "@/lib/videoFetcher";
import {
  addSubscriptionToList,
  clearAllSubscriptions,
  clearListSubscriptions,
  moveSubscription,
  readLists,
  removeSubscriptionFromList,
} from "@/lib/subscriptionListStore";

function getDefaultListId(userId: string) {
  return `default-${userId}`;
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const input = typeof body?.input === "string" ? body.input.trim() : "";
  const listId =
    typeof body?.listId === "string" && body.listId.trim().length > 0
      ? body.listId
      : getDefaultListId(user.id);

  if (!input) {
    return NextResponse.json({ error: "Input required" }, { status: 400 });
  }

  const channelId = await resolveChannelId(input);
  if (!channelId) {
    return NextResponse.json(
      { error: "Could not parse channel ID from input" },
      { status: 400 }
    );
  }

  let title = channelId;
  let thumbnail: string | undefined;
  try {
    const { meta } = await fetchChannelFeed(channelId);
    title = meta?.title || title;
    thumbnail = meta?.thumbnail;
  } catch {
    // Keep fallback values if metadata fetch fails
  }

  await addSubscriptionToList(
    listId,
    {
      id: channelId,
      channelId,
      title,
      thumbnail,
      url: `https://www.youtube.com/channel/${channelId}`,
      addedAt: new Date().toISOString(),
    },
    user.id
  );

  const lists = await readLists(user.id);
  const list = lists.lists.find((l) => l.id === listId);

  return NextResponse.json(
    list || {
      id: listId,
      name: "Default",
      subscriptions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  );
}

export async function PATCH(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const action = body?.action;

  if (action !== "move") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const channelId =
    typeof body?.channelId === "string" ? body.channelId.trim() : "";
  const fromListId =
    typeof body?.fromListId === "string" ? body.fromListId.trim() : "";
  const toListId =
    typeof body?.toListId === "string" ? body.toListId.trim() : "";

  if (!channelId || !fromListId || !toListId) {
    return NextResponse.json(
      { error: "channelId, fromListId and toListId are required" },
      { status: 400 }
    );
  }

  await moveSubscription(fromListId, toListId, channelId, user.id);
  const lists = await readLists(user.id);
  return NextResponse.json(lists);
}

export async function DELETE(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const action = body?.action;

  if (action === "clear") {
    const listId = typeof body?.listId === "string" ? body.listId.trim() : "";

    if (listId) {
      await clearListSubscriptions(listId, user.id);
    } else {
      await clearAllSubscriptions(user.id);
    }

    const lists = await readLists(user.id);
    return NextResponse.json(lists);
  }

  const channelId =
    typeof body?.channelId === "string" ? body.channelId.trim() : "";
  const listId =
    typeof body?.listId === "string" && body.listId.trim().length > 0
      ? body.listId
      : getDefaultListId(user.id);

  if (!channelId) {
    return NextResponse.json({ error: "channelId is required" }, { status: 400 });
  }

  await removeSubscriptionFromList(listId, channelId, user.id);
  return NextResponse.json({ success: true });
}
