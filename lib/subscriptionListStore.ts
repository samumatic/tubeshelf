import crypto from "crypto";
import { getDb } from "./db";
import { migrateFromJson } from "./migrate";

export interface SubscriptionInList {
  id: string;
  channelId: string;
  title: string;
  url: string;
  thumbnail?: string;
  addedAt: string;
  lastUploadedAt?: string;
}

export interface SubscriptionList {
  id: string;
  name: string;
  subscriptions: SubscriptionInList[];
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionListsData {
  lists: SubscriptionList[];
  defaultListId: string;
}

// Run migration on first import
let migrationPromise: Promise<void> | null = null;
async function ensureMigration() {
  if (!migrationPromise) {
    migrationPromise = migrateFromJson().catch((err) => {
      console.error("Migration failed:", err);
    });
  }
  await migrationPromise;
}

async function ensureDefaultList(userId: string) {
  const db = getDb();
  const exists = db
    .prepare(
      "SELECT COUNT(*) as count FROM subscription_lists WHERE user_id = ?"
    )
    .get(userId) as { count: number };

  if (exists.count === 0) {
    db.prepare(
      "INSERT OR IGNORE INTO subscription_lists (id, name, user_id, created_at) VALUES (?, ?, ?, ?)"
    ).run(`default-${userId}`, "Default", userId, new Date().toISOString());
  }
}

export async function readLists(
  userId: string
): Promise<SubscriptionListsData> {
  await ensureMigration();
  await ensureDefaultList(userId);

  const db = getDb();

  const lists = db
    .prepare(
      "SELECT id, name, created_at as createdAt FROM subscription_lists WHERE user_id = ? ORDER BY created_at"
    )
    .all(userId) as Array<{ id: string; name: string; createdAt: string }>;

  const result: SubscriptionList[] = [];
  let defaultListId = `default-${userId}`;

  for (const list of lists) {
    const subscriptions = db
      .prepare(
        "SELECT id, channel_id as channelId, title, url, thumbnail, added_at as addedAt, last_uploaded_at as lastUploadedAt FROM subscriptions WHERE list_id = ? ORDER BY added_at DESC"
      )
      .all(list.id) as SubscriptionInList[];

    result.push({
      id: list.id,
      name: list.name,
      subscriptions,
      createdAt: list.createdAt,
      updatedAt: list.createdAt, // SQLite doesn't track update time separately
    });
  }

  return {
    lists: result,
    defaultListId,
  };
}

export async function writeLists(data: SubscriptionListsData, userId: string) {
  await ensureMigration();
  const db = getDb();

  db.exec("BEGIN TRANSACTION");

  try {
    // Clear existing data for this user only
    db.prepare(
      "DELETE FROM subscriptions WHERE list_id IN (SELECT id FROM subscription_lists WHERE user_id = ?)"
    ).run(userId);
    db.prepare("DELETE FROM subscription_lists WHERE user_id = ?").run(userId);

    // Insert lists and subscriptions
    const listStmt = db.prepare(
      "INSERT INTO subscription_lists (id, name, user_id, created_at) VALUES (?, ?, ?, ?)"
    );
    const subStmt = db.prepare(
      "INSERT INTO subscriptions (list_id, channel_id, title, url, thumbnail, added_at, last_uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    for (const list of data.lists) {
      listStmt.run(list.id, list.name, userId, list.createdAt);

      for (const sub of list.subscriptions) {
        subStmt.run(
          list.id,
          sub.channelId,
          sub.title,
          sub.url,
          sub.thumbnail || null,
          sub.addedAt,
          sub.lastUploadedAt || null
        );
      }
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function createList(
  name: string,
  userId: string
): Promise<SubscriptionList> {
  await ensureMigration();
  const db = getDb();

  const newList: SubscriptionList = {
    id: Date.now().toString(),
    name,
    subscriptions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.prepare(
    "INSERT INTO subscription_lists (id, name, user_id, created_at) VALUES (?, ?, ?, ?)"
  ).run(newList.id, name, userId, newList.createdAt);

  return newList;
}

export async function updateList(
  id: string,
  updates: Partial<SubscriptionList>,
  userId: string
) {
  await ensureMigration();
  const db = getDb();

  if (updates.name) {
    db.prepare(
      "UPDATE subscription_lists SET name = ? WHERE id = ? AND user_id = ?"
    ).run(updates.name, id, userId);
  }
}

export async function deleteList(id: string, userId: string) {
  await ensureMigration();
  if (id === "default") {
    throw new Error("Cannot delete default list");
  }

  const db = getDb();
  db.prepare("DELETE FROM subscription_lists WHERE id = ? AND user_id = ?").run(
    id,
    userId
  );
  // Subscriptions are cascade deleted
}

export async function addSubscriptionToList(
  listId: string,
  subscription: SubscriptionInList,
  userId: string
) {
  await ensureMigration();
  const db = getDb();

  // Verify list ownership
  const listOwner = db
    .prepare("SELECT user_id FROM subscription_lists WHERE id = ?")
    .get(listId) as { user_id: string } | undefined;

  if (!listOwner || listOwner.user_id !== userId) {
    throw new Error("List not found or access denied");
  }

  const existing = db
    .prepare(
      "SELECT id FROM subscriptions WHERE list_id = ? AND channel_id = ?"
    )
    .get(listId, subscription.channelId);

  if (!existing) {
    db.prepare(
      "INSERT INTO subscriptions (list_id, channel_id, title, url, thumbnail, added_at, last_uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      listId,
      subscription.channelId,
      subscription.title,
      subscription.url,
      subscription.thumbnail || null,
      subscription.addedAt,
      subscription.lastUploadedAt || null
    );
  }
}

export async function removeSubscriptionFromList(
  listId: string,
  channelId: string,
  userId: string
) {
  await ensureMigration();
  const db = getDb();

  // Verify list ownership
  const listOwner = db
    .prepare("SELECT user_id FROM subscription_lists WHERE id = ?")
    .get(listId) as { user_id: string } | undefined;

  if (!listOwner || listOwner.user_id !== userId) {
    throw new Error("List not found or access denied");
  }

  db.prepare(
    "DELETE FROM subscriptions WHERE list_id = ? AND channel_id = ?"
  ).run(listId, channelId);
}

export async function clearListSubscriptions(listId: string, userId: string) {
  await ensureMigration();
  const db = getDb();

  // Verify list ownership
  const listOwner = db
    .prepare("SELECT user_id FROM subscription_lists WHERE id = ?")
    .get(listId) as { user_id: string } | undefined;

  if (!listOwner || listOwner.user_id !== userId) {
    throw new Error("List not found or access denied");
  }

  db.prepare("DELETE FROM subscriptions WHERE list_id = ?").run(listId);
}

export async function clearAllSubscriptions(userId: string) {
  await ensureMigration();
  const db = getDb();

  db.prepare(
    "DELETE FROM subscriptions WHERE list_id IN (SELECT id FROM subscription_lists WHERE user_id = ?)"
  ).run(userId);
}

export async function moveSubscription(
  fromListId: string,
  toListId: string,
  channelId: string,
  userId: string
) {
  await ensureMigration();
  const db = getDb();

  // Verify ownership of both lists
  const fromList = db
    .prepare("SELECT user_id FROM subscription_lists WHERE id = ?")
    .get(fromListId) as { user_id: string } | undefined;
  const toList = db
    .prepare("SELECT user_id FROM subscription_lists WHERE id = ?")
    .get(toListId) as { user_id: string } | undefined;

  if (
    !fromList ||
    fromList.user_id !== userId ||
    !toList ||
    toList.user_id !== userId
  ) {
    throw new Error("One or both lists not found or access denied");
  }

  const existing = db
    .prepare(
      "SELECT id FROM subscriptions WHERE list_id = ? AND channel_id = ?"
    )
    .get(toListId, channelId);

  if (existing) {
    // Already in target list, just remove from source
    db.prepare(
      "DELETE FROM subscriptions WHERE list_id = ? AND channel_id = ?"
    ).run(fromListId, channelId);
  } else {
    // Move to target list
    db.prepare(
      "UPDATE subscriptions SET list_id = ? WHERE list_id = ? AND channel_id = ?"
    ).run(toListId, fromListId, channelId);
  }
}

export interface SnapshotChannel {
  channelId: string;
  title: string;
  /** List names this channel belongs to. Empty means the default list. */
  groups: string[];
}

export interface SnapshotSyncResult {
  createdLists: string[];
  added: number;
  removed: number;
  channels: number;
}

const MAX_LIST_NAME_LENGTH = 64;

function normalizeListName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, MAX_LIST_NAME_LENGTH);
}

/**
 * Makes the user's lists match a complete subscription snapshot from another
 * tool (SubRelay's channel groups map to TubeShelf lists):
 *
 * - every snapshot channel ends up in each list named in its groups (lists
 *   are created as needed, matched by name case-insensitively);
 * - channels with no groups land in the default list;
 * - channels missing from the snapshot are removed from every list, and a
 *   snapshot channel is removed from non-default lists it's no longer
 *   grouped into.
 *
 * Existing default-list entries for snapshot channels are left alone, and no
 * list is ever deleted - an emptied list simply stays empty. The caller must
 * reject an empty snapshot; this would otherwise clear every list.
 */
export async function syncListsFromSnapshot(
  userId: string,
  snapshot: SnapshotChannel[]
): Promise<SnapshotSyncResult> {
  await ensureMigration();
  await ensureDefaultList(userId);

  const db = getDb();
  const defaultListId = `default-${userId}`;
  const result: SnapshotSyncResult = {
    createdLists: [],
    added: 0,
    removed: 0,
    channels: snapshot.length,
  };

  const tx = db.transaction(() => {
    // ensureDefaultList only creates it for users with no lists at all, so
    // make sure it exists before ungrouped channels are filed into it.
    db.prepare(
      "INSERT OR IGNORE INTO subscription_lists (id, name, user_id, created_at) VALUES (?, ?, ?, ?)"
    ).run(defaultListId, "Default", userId, new Date().toISOString());

    const lists = db
      .prepare("SELECT id, name FROM subscription_lists WHERE user_id = ?")
      .all(userId) as Array<{ id: string; name: string }>;

    const listIdByName = new Map<string, string>();
    for (const list of lists) {
      if (list.id === defaultListId) continue;
      const key = list.name.toLowerCase();
      if (!listIdByName.has(key)) listIdByName.set(key, list.id);
    }

    const insertList = db.prepare(
      "INSERT INTO subscription_lists (id, name, user_id, created_at) VALUES (?, ?, ?, ?)"
    );
    const listIdFor = (rawName: string): string => {
      const name = normalizeListName(rawName);
      if (!name || name.toLowerCase() === "default") return defaultListId;
      const existing = listIdByName.get(name.toLowerCase());
      if (existing) return existing;
      const id = crypto.randomUUID();
      insertList.run(id, name, userId, new Date().toISOString());
      listIdByName.set(name.toLowerCase(), id);
      result.createdLists.push(name);
      return id;
    };

    // Desired list memberships per channel.
    const desired = new Map<string, { title: string; listIds: Set<string> }>();
    for (const channel of snapshot) {
      const listIds = new Set<string>();
      for (const group of channel.groups) listIds.add(listIdFor(group));
      if (listIds.size === 0) listIds.add(defaultListId);
      const entry = desired.get(channel.channelId);
      if (entry) {
        for (const id of listIds) entry.listIds.add(id);
      } else {
        desired.set(channel.channelId, { title: channel.title, listIds });
      }
    }

    const current = db
      .prepare(
        `SELECT s.list_id AS listId, s.channel_id AS channelId
         FROM subscriptions s JOIN subscription_lists l ON l.id = s.list_id
         WHERE l.user_id = ?`
      )
      .all(userId) as Array<{ listId: string; channelId: string }>;

    const remove = db.prepare(
      "DELETE FROM subscriptions WHERE list_id = ? AND channel_id = ?"
    );
    const present = new Set<string>();
    for (const row of current) {
      const want = desired.get(row.channelId);
      const keep =
        want !== undefined &&
        (want.listIds.has(row.listId) || row.listId === defaultListId);
      if (keep) {
        present.add(`${row.listId}\u0000${row.channelId}`);
      } else {
        remove.run(row.listId, row.channelId);
        result.removed += 1;
      }
    }

    const insert = db.prepare(
      `INSERT OR IGNORE INTO subscriptions (id, list_id, channel_id, title, url, thumbnail, added_at, last_uploaded_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`
    );
    const now = new Date().toISOString();
    for (const [channelId, want] of desired) {
      for (const listId of want.listIds) {
        if (present.has(`${listId}\u0000${channelId}`)) continue;
        insert.run(
          channelId,
          listId,
          channelId,
          want.title || channelId,
          `https://www.youtube.com/channel/${channelId}`,
          now
        );
        result.added += 1;
      }
    }
  });

  tx();
  return result;
}
