import { getDb } from "./db";
import { migrateFromJson } from "./migrate";

export interface UserState {
  watchedVideos: string[];
  hideWatched: boolean;
  hideMemberOnly?: boolean;
  filterListId?: string;
  hasCompletedWelcome?: boolean;
  /**
   * How long this user wants videos kept, in days. 0 = forever,
   * null = follow the instance default (`videoRetentionDays`).
   */
  videoRetentionDays?: number | null;
  watchLater?: Array<{
    id: string;
    videoId: string;
    title: string;
    channel: string;
    thumbnail: string;
    addedAt: string;
  }>;
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

export async function readUserState(userId: string): Promise<UserState> {
  await ensureMigration();
  const db = getDb();

  // Read watched videos
  const watchedVideos = db
    .prepare(
      "SELECT video_id FROM watched_videos WHERE user_id = ? ORDER BY watched_at DESC"
    )
    .all(userId)
    .map((row: any) => row.video_id) as string[];

  // Read user config
  const configRows = db
    .prepare("SELECT key, value FROM user_config WHERE user_id = ?")
    .all(userId) as Array<{ key: string; value: string }>;

  const config: Record<string, any> = {};
  for (const row of configRows) {
    try {
      config[row.key] = JSON.parse(row.value);
    } catch {
      config[row.key] = row.value;
    }
  }

  // Read watch later
  const watchLater = db
    .prepare(
      "SELECT id, video_id as videoId, title, channel, thumbnail, added_at as addedAt FROM watch_later WHERE user_id = ? ORDER BY added_at DESC"
    )
    .all(userId) as Array<{
    id: string;
    videoId: string;
    title: string;
    channel: string;
    thumbnail: string;
    addedAt: string;
  }>;

  return {
    watchedVideos,
    hideWatched: config.hideWatched ?? false,
    hideMemberOnly: config.hideMemberOnly ?? false,
    filterListId: config.filterListId ?? "all",
    hasCompletedWelcome: config.hasCompletedWelcome ?? false,
    videoRetentionDays:
      typeof config.videoRetentionDays === "number"
        ? config.videoRetentionDays
        : null,
    watchLater,
  };
}

export async function writeUserState(state: UserState, userId: string) {
  await ensureMigration();
  const db = getDb();

  db.exec("BEGIN TRANSACTION");

  try {
    // Update watched videos
    db.prepare("DELETE FROM watched_videos WHERE user_id = ?").run(userId);
    const watchedStmt = db.prepare(
      "INSERT INTO watched_videos (video_id, user_id, watched_at) VALUES (?, ?, ?)"
    );
    for (const videoId of state.watchedVideos ?? []) {
      watchedStmt.run(videoId, userId, new Date().toISOString());
    }

    // Update user config
    db.prepare("DELETE FROM user_config WHERE user_id = ?").run(userId);
    const configStmt = db.prepare(
      "INSERT INTO user_config (user_id, key, value) VALUES (?, ?, ?)"
    );
    configStmt.run(userId, "hideWatched", JSON.stringify(!!state.hideWatched));
    configStmt.run(
      userId,
      "hideMemberOnly",
      JSON.stringify(!!state.hideMemberOnly)
    );
    configStmt.run(
      userId,
      "filterListId",
      JSON.stringify(state.filterListId ?? "all")
    );
    const hasCompletedValue = !!state.hasCompletedWelcome;
    configStmt.run(
      userId,
      "hasCompletedWelcome",
      JSON.stringify(hasCompletedValue)
    );
    // null means "follow the instance default" - store it so the row round-trips.
    configStmt.run(
      userId,
      "videoRetentionDays",
      JSON.stringify(
        typeof state.videoRetentionDays === "number"
          ? state.videoRetentionDays
          : null
      )
    );

    // Update watch later
    db.prepare("DELETE FROM watch_later WHERE user_id = ?").run(userId);
    const watchLaterStmt = db.prepare(
      "INSERT INTO watch_later (id, user_id, video_id, title, channel, thumbnail, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const item of state.watchLater ?? []) {
      watchLaterStmt.run(
        item.id,
        userId,
        item.videoId,
        item.title,
        item.channel,
        item.thumbnail,
        item.addedAt
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
