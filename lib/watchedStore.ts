import { getDb } from "./db";

export interface WatchedEntry {
  videoId: string;
  watchedAt: string;
}

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function listWatched(userId: string): WatchedEntry[] {
  return getDb()
    .prepare(
      `SELECT video_id AS videoId, watched_at AS watchedAt
       FROM watched_videos WHERE user_id = ? ORDER BY watched_at DESC`
    )
    .all(userId) as WatchedEntry[];
}

/**
 * Marks videos watched without touching existing entries - sync only ever
 * adds watched state. Returns how many videos were newly marked.
 */
export function addWatched(
  userId: string,
  entries: Array<{ videoId: string; watchedAt?: string | null }>
): number {
  const db = getDb();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO watched_videos (video_id, user_id, watched_at) VALUES (?, ?, ?)"
  );
  const now = new Date().toISOString();
  let added = 0;
  const tx = db.transaction(() => {
    for (const entry of entries) {
      if (!VIDEO_ID_PATTERN.test(entry.videoId)) continue;
      const parsed = entry.watchedAt ? new Date(entry.watchedAt) : null;
      const watchedAt =
        parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : now;
      added += insert.run(entry.videoId, userId, watchedAt).changes;
    }
  });
  tx();
  return added;
}

/**
 * Reads watched entries from `{"watched": [...]}` or a bare array, where each
 * item is a video id or `{videoId, watchedAt?}`. Returns null for any other shape.
 */
export function parseWatchedBody(body: unknown): WatchedEntry[] | null {
  const items = Array.isArray(body)
    ? body
    : Array.isArray((body as any)?.watched)
      ? (body as any).watched
      : null;
  if (!items) return null;

  const entries: WatchedEntry[] = [];
  for (const item of items) {
    const videoId =
      typeof item === "string"
        ? item.trim()
        : typeof item?.videoId === "string"
          ? item.videoId.trim()
          : "";
    if (!VIDEO_ID_PATTERN.test(videoId)) continue;
    const watchedAt =
      typeof item === "object" && typeof item?.watchedAt === "string"
        ? item.watchedAt
        : "";
    entries.push({ videoId, watchedAt });
  }
  return entries;
}
