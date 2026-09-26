import { NextResponse } from "next/server";
import {
  readLists,
  createList,
  updateList,
  deleteList,
  syncListsFromSnapshot,
  type SnapshotChannel,
} from "@/lib/subscriptionListStore";
import { requireUser } from "@/lib/apiAuth";

const MAX_SNAPSHOT_CHANNELS = 20000;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function channelIdFrom(raw: string): string {
  const match = /(UC[A-Za-z0-9_-]{22})/.exec(raw);
  return match ? match[1] : "";
}

/**
 * Parses a full subscription snapshot: `{"subscriptions": [...]}` or a bare
 * array, where each item has a channel id (`channelId`/`channel_id`/`id`/`url`),
 * an optional title, and optional `groups` (or `tags`) naming its lists.
 */
function parseSnapshot(body: unknown): SnapshotChannel[] | null {
  const items = Array.isArray(body)
    ? body
    : Array.isArray((body as any)?.subscriptions)
      ? (body as any).subscriptions
      : null;
  if (!items) return null;

  const channels: SnapshotChannel[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const channelId = channelIdFrom(
      firstString(item.channelId, item.channel_id, item.id, item.url)
    );
    if (!CHANNEL_ID_PATTERN.test(channelId)) continue;
    const rawGroups = Array.isArray(item.groups)
      ? item.groups
      : Array.isArray(item.tags)
        ? item.tags
        : [];
    channels.push({
      channelId,
      title: firstString(item.title, item.name) || channelId,
      groups: rawGroups.filter((group: unknown): group is string => typeof group === "string"),
    });
  }
  return channels;
}

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const data = await readLists(user.id);
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const { action, name, listId, updates } = body || {};

  try {
    if (action === "create") {
      if (!name) {
        console.error("[API] Create list failed: Name required");
        return NextResponse.json(
          { error: "List name required" },
          { status: 400 }
        );
      }
      const newList = await createList(name, user.id);
      return NextResponse.json(newList);
    } else if (action === "update") {
      if (!listId) {
        console.error("[API] Update list failed: List ID required");
        return NextResponse.json(
          { error: "List ID required" },
          { status: 400 }
        );
      }
      await updateList(listId, updates, user.id);
      const data = await readLists(user.id);
      return NextResponse.json(data);
    } else if (action === "delete") {
      if (!listId) {
        console.error("[API] Delete list failed: List ID required");
        return NextResponse.json(
          { error: "List ID required" },
          { status: 400 }
        );
      }
      await deleteList(listId, user.id);
      const data = await readLists(user.id);
      return NextResponse.json(data);
    } else {
      console.error(
        "[API] Subscription list operation failed: Unknown action",
        { action }
      );
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err: any) {
    console.error("[API] Subscription list operation error", {
      action,
      listId,
      error: err?.message || String(err),
      stack: err?.stack,
    });
    return NextResponse.json(
      { error: err?.message || "Operation failed" },
      { status: 400 }
    );
  }
}

/**
 * Replaces the user's list memberships with a complete snapshot, mapping each
 * channel's `groups` onto lists of the same name. Used by SubRelay to push
 * its channel groups; see syncListsFromSnapshot for the exact rules.
 */
export async function PUT(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const snapshot = parseSnapshot(body);
  if (!snapshot) {
    return NextResponse.json(
      { error: "Expected {\"subscriptions\": [...]} or an array of subscriptions" },
      { status: 400 }
    );
  }
  if (snapshot.length === 0) {
    // A snapshot is the complete desired state, so an empty one would clear
    // every list. Refuse rather than risk wiping subscriptions by accident.
    return NextResponse.json(
      { error: "Snapshot contains no valid YouTube channel IDs; refusing to clear all lists" },
      { status: 400 }
    );
  }
  if (snapshot.length > MAX_SNAPSHOT_CHANNELS) {
    return NextResponse.json(
      { error: `Snapshot exceeds ${MAX_SNAPSHOT_CHANNELS} channels` },
      { status: 413 }
    );
  }

  const result = await syncListsFromSnapshot(user.id, snapshot);
  const lists = await readLists(user.id);
  return NextResponse.json({ ...result, ...lists });
}
