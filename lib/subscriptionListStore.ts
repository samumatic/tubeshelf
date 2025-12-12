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
  try {
    const parsed = JSON.parse(raw);
    if (parsed.lists && Array.isArray(parsed.lists)) {
      return parsed;
    }
    // Migration from old format
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
  } catch {
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
  await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8");
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
  if (!list) throw new Error("List not found");
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
  if (!list) throw new Error("List not found");
  list.subscriptions = list.subscriptions.filter(
    (s) => s.channelId !== channelId
  );
  list.updatedAt = new Date().toISOString();
  await writeLists(data);
}

export async function clearListSubscriptions(listId: string) {
  const data = await readLists();
  const list = data.lists.find((l) => l.id === listId);
  if (!list) throw new Error("List not found");
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
