import { promises as fs } from "fs";
import path from "path";

export interface StoredSubscription {
  id: string;
  channelId: string;
  title: string;
  url: string;
  thumbnail?: string;
  addedAt: string;
}

const dataFile = path.join(process.cwd(), "data", "subscriptions.json");

async function ensureFile() {
  try {
    await fs.access(dataFile);
  } catch {
    await fs.mkdir(path.dirname(dataFile), { recursive: true });
    await fs.writeFile(dataFile, "[]", "utf8");
  }
}

export async function readSubscriptions(): Promise<StoredSubscription[]> {
  await ensureFile();
  const raw = await fs.readFile(dataFile, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [];
  } catch {
    return [];
  }
}

export async function writeSubscriptions(subs: StoredSubscription[]) {
  await ensureFile();
  await fs.writeFile(dataFile, JSON.stringify(subs, null, 2), "utf8");
}

