import { getDb } from "./db";

const SQLITE_MAX_VARIABLES = 900;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FetchedVideo {
  id?: string;
  videoId?: string;
  title?: string;
  channelId?: string;
  channelTitle?: string;
  publishedAt?: string;
  url?: string;
  thumbnail?: string;
  duration?: string;
  viewCount?: number;
  views?: number;
  isMemberOnly?: boolean;
}

export interface CachedVideo {
  id: string;
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  url: string;
  thumbnail?: string;
  duration?: string;
  viewCount?: number;
  views?: number;
  isMemberOnly: boolean;
  firstSeenAt: number;
}

export interface ChannelFetchState {
  channelId: string;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  videoCount: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Normalize timestamps to ISO-8601 UTC so stored values stay comparable.
 * RSS reports `+00:00` offsets while the standard fetcher reports `Z`, and the
 * upsert compares published dates as strings.
 */
function normalizeDate(value: string | undefined, fallbackMs: number): string {
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

/**
 * Persist fetched videos.
 *
 * New rows keep the order of the incoming batch in `first_seen_at` (ms + index)
 * so the feed has a stable tie-breaker when YouTube only exposes coarse
 * timestamps like "14 hours ago". Existing rows keep their `first_seen_at` and
 * the earliest known `published_at`; mutable metadata (title, thumbnail,
 * duration, views) is refreshed, and fields the current fetch method cannot
 * provide (RSS has no duration or members-only flag) fall back to the stored
 * value instead of overwriting it with NULL.
 */
export function upsertVideos(
  channelId: string,
  videos: FetchedVideo[]
): number {
  if (videos.length === 0) return 0;

  const db = getDb();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  const insert = db.prepare(`
    INSERT INTO videos (
      video_id, channel_id, channel_title, title, url, thumbnail, duration,
      view_count, is_member_only, published_at, first_seen_at, last_seen_at
    ) VALUES (
      @videoId, @channelId, @channelTitle, @title, @url, @thumbnail, @duration,
      @viewCount, @isMemberOnly, @publishedAt,
      COALESCE(
        (SELECT first_seen_at FROM video_first_seen WHERE video_id = @videoId),
        @firstSeenAt
      ),
      @lastSeenAt
    )
    ON CONFLICT(video_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      channel_title = COALESCE(excluded.channel_title, videos.channel_title),
      title = excluded.title,
      url = excluded.url,
      thumbnail = COALESCE(excluded.thumbnail, videos.thumbnail),
      duration = COALESCE(excluded.duration, videos.duration),
      view_count = COALESCE(excluded.view_count, videos.view_count),
      is_member_only = COALESCE(excluded.is_member_only, videos.is_member_only),
      published_at = MIN(excluded.published_at, videos.published_at),
      last_seen_at = excluded.last_seen_at
  `);

  let written = 0;

  const tx = db.transaction(() => {
    videos.forEach((video, index) => {
      const videoId = String(video.id || video.videoId || "").trim();
      if (!videoId) return;

      insert.run({
        videoId,
        channelId: String(video.channelId || channelId),
        channelTitle: video.channelTitle || null,
        title: video.title || "Untitled",
        url: video.url || `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: video.thumbnail || null,
        duration: video.duration || null,
        viewCount: video.viewCount ?? video.views ?? null,
        // undefined means "this fetch method cannot tell" - keep what we have.
        isMemberOnly:
          video.isMemberOnly === undefined ? null : video.isMemberOnly ? 1 : 0,
        publishedAt: normalizeDate(video.publishedAt, nowMs),
        firstSeenAt: new Date(nowMs + index).toISOString(),
        lastSeenAt: now,
      });
      written++;
    });
  });

  tx();
  return written;
}

/**
 * Read cached videos for the given channels.
 *
 * `retentionDays` limits the result to videos published within that window
 * (0 or undefined = no limit); it only filters what is returned, deleting is
 * done by `pruneVideos`.
 */
export function getCachedVideos(
  channelIds: string[],
  retentionDays = 0
): CachedVideo[] {
  const unique = Array.from(new Set(channelIds.filter(Boolean)));
  if (unique.length === 0) return [];

  const db = getDb();
  const rows: Array<Record<string, any>> = [];
  const cutoff =
    retentionDays > 0
      ? new Date(Date.now() - retentionDays * DAY_MS).toISOString()
      : null;

  for (const part of chunk(unique, SQLITE_MAX_VARIABLES)) {
    const placeholders = part.map(() => "?").join(", ");
    const stmt = db.prepare(
      `SELECT video_id, channel_id, channel_title, title, url, thumbnail,
              duration, view_count, is_member_only, published_at, first_seen_at
       FROM videos
       WHERE channel_id IN (${placeholders})
         ${cutoff ? "AND published_at >= ?" : ""}`
    );
    const args = cutoff ? [...part, cutoff] : part;
    rows.push(...(stmt.all(...args) as Array<Record<string, any>>));
  }

  return rows.map((row) => {
    const firstSeen = Date.parse(row.first_seen_at);
    return {
      id: row.video_id,
      videoId: row.video_id,
      title: row.title,
      channelId: row.channel_id,
      channelTitle: row.channel_title || "Unknown Channel",
      publishedAt: row.published_at,
      url: row.url,
      thumbnail: row.thumbnail || undefined,
      duration: row.duration || undefined,
      viewCount: row.view_count ?? undefined,
      views: row.view_count ?? undefined,
      isMemberOnly: !!row.is_member_only,
      firstSeenAt: Number.isFinite(firstSeen) ? firstSeen : 0,
    };
  });
}

export function countCachedVideos(channelIds: string[]): number {
  const unique = Array.from(new Set(channelIds.filter(Boolean)));
  if (unique.length === 0) return 0;

  const db = getDb();
  let total = 0;

  for (const part of chunk(unique, SQLITE_MAX_VARIABLES)) {
    const placeholders = part.map(() => "?").join(", ");
    const row = db
      .prepare(
        `SELECT COUNT(*) as count FROM videos WHERE channel_id IN (${placeholders})`
      )
      .get(...part) as { count: number };
    total += row?.count || 0;
  }

  return total;
}

export function getChannelFetchStates(
  channelIds: string[]
): Map<string, ChannelFetchState> {
  const unique = Array.from(new Set(channelIds.filter(Boolean)));
  const states = new Map<string, ChannelFetchState>();
  if (unique.length === 0) return states;

  const db = getDb();

  for (const part of chunk(unique, SQLITE_MAX_VARIABLES)) {
    const placeholders = part.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT channel_id, last_fetched_at, last_success_at, last_error, video_count
         FROM channel_fetch_state
         WHERE channel_id IN (${placeholders})`
      )
      .all(...part) as Array<Record<string, any>>;

    for (const row of rows) {
      states.set(row.channel_id, {
        channelId: row.channel_id,
        lastFetchedAt: row.last_fetched_at,
        lastSuccessAt: row.last_success_at,
        lastError: row.last_error,
        videoCount: row.video_count ?? 0,
      });
    }
  }

  return states;
}

export function markChannelFetched(
  channelId: string,
  result: { videoCount: number; error?: string | null }
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const error = result.error ? String(result.error).slice(0, 500) : null;

  db.prepare(
    `INSERT INTO channel_fetch_state (
       channel_id, last_fetched_at, last_success_at, last_error, video_count
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       last_fetched_at = excluded.last_fetched_at,
       last_success_at = COALESCE(excluded.last_success_at, channel_fetch_state.last_success_at),
       last_error = excluded.last_error,
       video_count = excluded.video_count`
  ).run(channelId, now, error ? null : now, error, result.videoCount);
}

/**
 * Retention window that applies to a user, in days (0 = forever).
 */
export function effectiveRetentionDays(
  userOverride: number | null | undefined,
  globalDefault: number
): number {
  return typeof userOverride === "number" ? userOverride : globalDefault;
}

/**
 * How long each channel's videos must be kept: the most generous window among
 * the users subscribed to it, since one shared row serves every user. A single
 * subscriber asking for "forever" keeps the whole channel. Channels nobody
 * subscribes to fall back to the instance default.
 */
export function getChannelRetentionWindows(
  globalDefault: number
): Map<string, number> {
  const db = getDb();

  const overrides = new Map<string, number>();
  const overrideRows = db
    .prepare("SELECT user_id, value FROM user_config WHERE key = ?")
    .all("videoRetentionDays") as Array<{ user_id: string; value: string }>;

  for (const row of overrideRows) {
    try {
      const parsed = JSON.parse(row.value);
      if (typeof parsed === "number" && Number.isFinite(parsed)) {
        overrides.set(row.user_id, Math.max(0, Math.round(parsed)));
      }
    } catch {
      // Ignore malformed overrides and fall back to the default.
    }
  }

  const subscriberRows = db
    .prepare(
      `SELECT DISTINCT s.channel_id AS channelId, l.user_id AS userId
       FROM subscriptions s
       JOIN subscription_lists l ON l.id = s.list_id`
    )
    .all() as Array<{ channelId: string; userId: string }>;

  const windows = new Map<string, number>();

  for (const row of subscriberRows) {
    const userWindow = effectiveRetentionDays(
      overrides.get(row.userId),
      globalDefault
    );
    const current = windows.get(row.channelId);

    if (current === undefined) {
      windows.set(row.channelId, userWindow);
      continue;
    }
    // 0 means forever and always wins.
    if (current === 0 || userWindow === 0) {
      windows.set(row.channelId, 0);
      continue;
    }
    windows.set(row.channelId, Math.max(current, userWindow));
  }

  return windows;
}

/**
 * Delete cached videos older than the retention window that applies to their
 * channel. Returns the number of deleted rows.
 */
export function pruneVideos(globalDefault: number): number {
  const db = getDb();
  const windows = getChannelRetentionWindows(globalDefault);

  const cachedChannels = (
    db.prepare("SELECT DISTINCT channel_id AS channelId FROM videos").all() as
      Array<{ channelId: string }>
  ).map((row) => row.channelId);

  // Group channels by window so one statement covers all channels that share it.
  const channelsByWindow = new Map<number, string[]>();
  for (const channelId of cachedChannels) {
    const window = windows.get(channelId) ?? globalDefault;
    if (window <= 0) continue; // forever
    const bucket = channelsByWindow.get(window);
    if (bucket) bucket.push(channelId);
    else channelsByWindow.set(window, [channelId]);
  }

  let deleted = 0;

  const tx = db.transaction(() => {
    for (const [window, channels] of channelsByWindow) {
      const cutoff = new Date(Date.now() - window * DAY_MS).toISOString();

      for (const part of chunk(channels, SQLITE_MAX_VARIABLES - 1)) {
        const placeholders = part.map(() => "?").join(", ");
        const info = db
          .prepare(
            `DELETE FROM videos
             WHERE channel_id IN (${placeholders})
               AND published_at < ?`
          )
          .run(...part, cutoff);
        deleted += info.changes;
      }
    }

    // Forget fetch bookkeeping for channels that are neither subscribed nor cached.
    db.prepare(
      `DELETE FROM channel_fetch_state
       WHERE channel_id NOT IN (SELECT DISTINCT channel_id FROM subscriptions)
         AND channel_id NOT IN (SELECT DISTINCT channel_id FROM videos)`
    ).run();
  });

  tx();
  return deleted;
}
