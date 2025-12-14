import { promises as fs } from "fs";
import path from "path";

export interface SubscriptionInList {
  id: string;
  channelId: string;
  title: string;
  url: string;
  thumbnail?: string;
  addedAt: string;
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

const dataFile = path.join(process.cwd(), "data", "subscription-lists.json");

async function ensureFile() {
  try {
    await fs.access(dataFile);
  } catch {
    await fs.mkdir(path.dirname(dataFile), { recursive: true });

    // Try to migrate from old subscriptions.json
    let subscriptions: SubscriptionInList[] = [];
    const oldFile = path.join(process.cwd(), "data", "subscriptions.json");
    try {
      const oldData = await fs.readFile(oldFile, "utf8");
      const parsed = JSON.parse(oldData);
      if (Array.isArray(parsed)) {
        subscriptions = parsed;
      }
    } catch {
      // Old file doesn't exist, start fresh
    }

    const defaultList: SubscriptionList = {
      id: "default",
      name: "Default",
      subscriptions,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const initialData: SubscriptionListsData = {
      lists: [defaultList],
      defaultListId: "default",
    };
    await fs.writeFile(dataFile, JSON.stringify(initialData, null, 2), "utf8");
  }
}

export async function readLists(): Promise<SubscriptionListsData> {
  await ensureFile();
  const raw = await fs.readFile(dataFile, "utf8");

  // Handle empty or whitespace-only files
  if (!raw || !raw.trim()) {
    console.warn("[Store] Empty subscription lists file, creating defaults");
    const defaultData: SubscriptionListsData = {
      lists: [
        {
          id: "default",
          name: "Default",
          subscriptions: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      defaultListId: "default",
    };
    await writeLists(defaultData);
    return defaultData;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed.lists && Array.isArray(parsed.lists)) {
      return parsed;
    }
    // Migration from old format
    console.warn("[Store] Migrating subscription data from old format");
    return {
      lists: [
        {
          id: "default",
          name: "Default",
          subscriptions: parsed,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      defaultListId: "default",
    };
  } catch (err) {
    console.error("[Store] Failed to read subscription lists, using defaults", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      lists: [
        {
          id: "default",
          name: "Default",
          subscriptions: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      defaultListId: "default",
    };
  }
}

export async function writeLists(data: SubscriptionListsData) {
  await ensureFile();
  // Atomic write: write to temp file first, then rename
  const tempFile = dataFile + ".tmp";
  try {
    await fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tempFile, dataFile);
  } catch (err) {
    // Clean up temp file if rename fails
    try {
      await fs.unlink(tempFile);
    } catch {}
    throw err;
  }
}

export async function createList(name: string): Promise<SubscriptionList> {
  const data = await readLists();
  const newList: SubscriptionList = {
    id: Date.now().toString(),
    name,
    subscriptions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.lists.push(newList);
  await writeLists(data);
  return newList;
}

export async function updateList(
  id: string,
  updates: Partial<SubscriptionList>
) {
  const data = await readLists();
  const list = data.lists.find((l) => l.id === id);
  if (!list) throw new Error("List not found");
  Object.assign(list, updates, {
    updatedAt: new Date().toISOString(),
  });
  await writeLists(data);
}

export async function deleteList(id: string) {
  const data = await readLists();
  if (data.defaultListId === id) {
    console.error("[Store] Cannot delete default list", { id });
    throw new Error("Cannot delete default list");
  }
  data.lists = data.lists.filter((l) => l.id !== id);
  await writeLists(data);
}

export async function addSubscriptionToList(
  listId: string,
  subscription: SubscriptionInList
) {
  const data = await readLists();
  const list = data.lists.find((l) => l.id === listId);
  if (!list) {
    console.error("[Store] Cannot add subscription: List not found", {
      listId,
    });
    throw new Error("List not found");
  }
  if (!list.subscriptions.some((s) => s.channelId === subscription.channelId)) {
    list.subscriptions.push(subscription);
    list.updatedAt = new Date().toISOString();
    await writeLists(data);
  }
}

export async function removeSubscriptionFromList(
  listId: string,
  channelId: string
) {
  const data = await readLists();
  const list = data.lists.find((l) => l.id === listId);
  if (!list) {
    console.error("[Store] Cannot remove subscription: List not found", {
      listId,
    });
    throw new Error("List not found");
  }
  list.subscriptions = list.subscriptions.filter(
    (s) => s.channelId !== channelId
  );
  list.updatedAt = new Date().toISOString();
  await writeLists(data);
}

export async function clearListSubscriptions(listId: string) {
  const data = await readLists();
  const list = data.lists.find((l) => l.id === listId);
  if (!list) {
    console.error("[Store] Cannot clear subscriptions: List not found", {
      listId,
    });
    throw new Error("List not found");
  }
  list.subscriptions = [];
  list.updatedAt = new Date().toISOString();
  await writeLists(data);
}

export async function clearAllSubscriptions() {
  const data = await readLists();
  data.lists.forEach((list) => {
    list.subscriptions = [];
    list.updatedAt = new Date().toISOString();
  });
  await writeLists(data);
}

export async function moveSubscription(
  fromListId: string,
  toListId: string,
  channelId: string
) {
  const data = await readLists();
  const fromList = data.lists.find((l) => l.id === fromListId);
  const toList = data.lists.find((l) => l.id === toListId);

  if (!fromList) {
    console.error("[Store] Cannot move subscription: Source list not found", {
      fromListId,
      toListId,
      channelId,
    });
    throw new Error("Source list not found");
  }
  if (!toList) {
    console.error("[Store] Cannot move subscription: Target list not found", {
      fromListId,
      toListId,
      channelId,
    });
    throw new Error("Target list not found");
  }

  const subscription = fromList.subscriptions.find(
    (s) => s.channelId === channelId
  );
  if (!subscription) {
    console.error(
      "[Store] Cannot move subscription: Subscription not found in source list",
      {
        fromListId,
        toListId,
        channelId,
      }
    );
    throw new Error("Subscription not found");
  }

  // Remove from source list
  fromList.subscriptions = fromList.subscriptions.filter(
    (s) => s.channelId !== channelId
  );
  fromList.updatedAt = new Date().toISOString();

  // Add to target list if not already there
  if (!toList.subscriptions.some((s) => s.channelId === channelId)) {
    toList.subscriptions.push(subscription);
    toList.updatedAt = new Date().toISOString();
  }

  await writeLists(data);
}
