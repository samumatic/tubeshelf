import { getDb } from "./db";

// Watched state shared with other apps (SubRelay) is just which videos are
// watched: a set of YouTube video ids. watched_at stays local bookkeeping
// (when this TubeShelf first recorded it) and is never synced.

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function listWatchedIds(userId: string): string[] {
  return (
    getDb()
      .prepare("SELECT video_id FROM watched_videos WHERE user_id = ? ORDER BY video_id")
      .all(userId) as Array<{ video_id: string }>
  ).map((row) => row.video_id);
}

/**
 * Marks videos watched without touching existing entries - sync only ever
 * adds watched state. Returns the ids that were newly marked.
 */
export function addWatchedIds(userId: string, videoIds: Iterable<string>): string[] {
  const db = getDb();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO watched_videos (video_id, user_id, watched_at) VALUES (?, ?, ?)"
  );
  const now = new Date().toISOString();
  const added: string[] = [];
  const tx = db.transaction(() => {
    for (const videoId of videoIds) {
      if (!VIDEO_ID_PATTERN.test(videoId)) continue;
      if (insert.run(videoId, userId, now).changes > 0) added.push(videoId);
    }
  });
  tx();
  return added;
}

/**
 * Reads video ids from a bare array or an object holding one under
 * "videoIds" / "watched" / "watchedVideos". Items are ids or objects with a
 * videoId; anything else (timestamps included) is ignored. Returns null for
 * any other shape.
 */
export function parseWatchedIds(body: unknown): string[] | null {
  const container = body as Record<string, unknown> | null;
  const items = Array.isArray(body)
    ? body
    : Array.isArray(container?.videoIds)
      ? container.videoIds
      : Array.isArray(container?.watched)
        ? container.watched
        : Array.isArray(container?.watchedVideos)
          ? container.watchedVideos
          : null;
  if (!items) return null;

  const ids = new Set<string>();
  for (const item of items as unknown[]) {
    const candidate =
      typeof item === "string"
        ? item.trim()
        : typeof (item as { videoId?: unknown })?.videoId === "string"
          ? ((item as { videoId: string }).videoId).trim()
          : "";
    if (VIDEO_ID_PATTERN.test(candidate)) ids.add(candidate);
  }
  return [...ids];
}
