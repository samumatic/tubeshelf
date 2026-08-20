import Database from "better-sqlite3";
import path from "path";
import { existsSync, mkdirSync } from "fs";
import { parseDurationText } from "./duration";

// Overridable for tests only, so they run against an isolated database
// instead of a real instance's data/tubeshelf.db. Unset in every real
// deployment, so production behavior is unchanged.
const dbPath =
  process.env.TUBESHELF_TEST_DB_PATH ||
  path.join(process.cwd(), "data", "tubeshelf.db");
let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    // Ensure data directory exists
    const dataDir = path.dirname(dbPath);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initializeSchema();
  }
  return db;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function replaceCreateTableName(
  createSql: string,
  currentName: string,
  nextName: string,
): string {
  const escapedName = currentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^(CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?)(["\`\\[]?)${escapedName}(["\`\\]]?)`,
    "i",
  );
  return createSql.replace(pattern, `$1${quoteIdentifier(nextName)}`);
}

export function repairBrokenUserForeignKeys() {
  if (!db) return;

  const affectedTables = db
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND sql LIKE '%users_old%'`,
    )
    .all() as Array<{ name: string; sql: string | null }>;

  if (!affectedTables.length) return;

  console.log(
    `[Migration] Repairing broken users_old foreign keys in ${affectedTables.length} tables`,
  );

  db.exec("PRAGMA foreign_keys = OFF");

  try {
    const tx = db.transaction(() => {
      for (const table of affectedTables) {
        if (!table.sql || table.name === "users" || table.name === "users_old") {
          continue;
        }

        const tempTableName = `__repair_${table.name}`;
        const columns = db!.prepare(
          `PRAGMA table_info(${quoteIdentifier(table.name)})`,
        ).all() as Array<{ name: string }>;

        if (!columns.length) continue;

        const dependentObjects = db!
          .prepare(
            `SELECT type, sql
             FROM sqlite_master
             WHERE tbl_name = ?
               AND type IN ('index', 'trigger')
               AND sql IS NOT NULL
             ORDER BY type, name`,
          )
          .all(table.name) as Array<{ type: string; sql: string }>;

        const rebuiltCreateSql = replaceCreateTableName(
          table.sql,
          table.name,
          tempTableName,
        ).replace(/\busers_old\b/g, "users");

        const columnList = columns
          .map((column) => quoteIdentifier(column.name))
          .join(", ");

        db!.exec(rebuiltCreateSql);
        db!.exec(
          `INSERT INTO ${quoteIdentifier(tempTableName)} (${columnList})
           SELECT ${columnList} FROM ${quoteIdentifier(table.name)}`,
        );
        db!.exec(`DROP TABLE ${quoteIdentifier(table.name)}`);
        db!.exec(
          `ALTER TABLE ${quoteIdentifier(tempTableName)} RENAME TO ${quoteIdentifier(table.name)}`,
        );

        for (const object of dependentObjects) {
          db!.exec(object.sql);
        }
      }
    });

    tx();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function initializeSchema() {
  if (!db) return;

  // Settings table (key-value for flexibility)
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // First-seen cache for videos (used to keep feed ordering stable when
  // YouTube only exposes coarse relative timestamps like "14 hours ago").
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_first_seen (
      video_id TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_video_first_seen_first_seen_at
    ON video_first_seen(first_seen_at);
  `);

  // Persistent video cache. The feed is served from this table so videos stay
  // available after they scroll out of the upstream fetch window (~15 entries
  // for RSS, ~30 for the standard fetcher) and survive failed refreshes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      channel_title TEXT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      thumbnail TEXT,
      duration TEXT,
      duration_seconds INTEGER,
      duration_attempts INTEGER NOT NULL DEFAULT 0,
      view_count INTEGER,
      is_member_only INTEGER,
      published_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id);
    CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_videos_last_seen_at ON videos(last_seen_at);
  `);

  // Per-channel refresh bookkeeping, used to decide which channels are stale
  // and to keep the last fetch error for diagnostics.
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_fetch_state (
      channel_id TEXT PRIMARY KEY,
      last_fetched_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      video_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Subscription lists
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscription_lists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    
    CREATE INDEX IF NOT EXISTS idx_subscription_lists_user_id 
    ON subscription_lists(user_id);
  `);

  // Subscriptions (composite primary key: list_id, channel_id)
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT,
      list_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      thumbnail TEXT,
      added_at TEXT NOT NULL,
      last_uploaded_at TEXT,
      PRIMARY KEY (list_id, channel_id),
      FOREIGN KEY (list_id) REFERENCES subscription_lists(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_list_id 
    ON subscriptions(list_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_channel_id 
    ON subscriptions(channel_id);
  `);

  // Playback history - created without user_id initially, will be migrated
  // Check if table exists first
  const playbackHistoryExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='playback_history'",
    )
    .get() as { name: string } | undefined;

  if (!playbackHistoryExists) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS playback_history (
        video_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        video_title TEXT NOT NULL,
        channel_id TEXT,
        channel_name TEXT NOT NULL,
        thumbnail TEXT,
        timestamp TEXT NOT NULL,
        duration REAL NOT NULL,
        progress REAL NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (video_id, user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_playback_history_user_id 
      ON playback_history(user_id);
      
      CREATE INDEX IF NOT EXISTS idx_playback_history_timestamp 
      ON playback_history(timestamp DESC);
    `);
  }

  // Watched videos
  db.exec(`
    CREATE TABLE IF NOT EXISTS watched_videos (
      video_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      watched_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (video_id, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    
    CREATE INDEX IF NOT EXISTS idx_watched_videos_user_id 
    ON watched_videos(user_id);
  `);

  // Watch later
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_later (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      channel TEXT NOT NULL,
      thumbnail TEXT NOT NULL,
      added_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    
    CREATE INDEX IF NOT EXISTS idx_watch_later_user_id 
    ON watch_later(user_id);
    
    CREATE INDEX IF NOT EXISTS idx_watch_later_added_at 
    ON watch_later(added_at DESC);
  `);

  // User config (stored as key-value for flexibility, per user)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_config (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    
    CREATE INDEX IF NOT EXISTS idx_user_config_user_id 
    ON user_config(user_id);
  `);

  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT,
      oidc_provider TEXT,
      oidc_subject TEXT,
      created_at DATE NOT NULL DEFAULT (datetime('now')),
      last_login_at DATE,
      updated_at DATE,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_default_admin INTEGER NOT NULL DEFAULT 0,
      email_verified INTEGER NOT NULL DEFAULT 1,
      image TEXT
    );
    
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email 
    ON users(email);
    
    CREATE INDEX IF NOT EXISTS idx_users_oidc 
    ON users(oidc_provider, oidc_subject);
  `);

  // OIDC providers configuration
  db.exec(`
    CREATE TABLE IF NOT EXISTS oidc_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      issuer TEXT NOT NULL,
      base_url TEXT,
      discovery_url TEXT,
      domain TEXT,
      redirect_uri TEXT,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      scopes TEXT DEFAULT 'openid profile email groups',
      auto_provision INTEGER NOT NULL DEFAULT 0,
      group_claim_name TEXT,
      admin_group_value TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  repairBrokenUserForeignKeys();

  // Run migrations for existing databases
  runMigrations();
}

function runMigrations() {
  if (!db) return;

  try {
    // Migration: Add is_default_admin column if it doesn't exist
    const tableInfo = db.pragma("table_info(users)") as Array<any>;
    const hasDefaultAdminColumn = tableInfo.some(
      (col: any) => col.name === "is_default_admin",
    );
    const hasUpdatedAtColumn = tableInfo.some(
      (col: any) => col.name === "updated_at",
    );
    const hasEmailVerifiedColumn = tableInfo.some(
      (col: any) => col.name === "email_verified",
    );
    const hasImageColumn = tableInfo.some((col: any) => col.name === "image");

    if (!hasDefaultAdminColumn) {
      console.log("[Migration] Adding is_default_admin column to users table");
      db.exec(`
        ALTER TABLE users ADD COLUMN is_default_admin INTEGER NOT NULL DEFAULT 0;
      `);
    }

    if (!hasUpdatedAtColumn) {
      console.log("[Migration] Adding updated_at column to users table");
      db.exec(`
        ALTER TABLE users ADD COLUMN updated_at DATE;
      `);
    }

    if (!hasEmailVerifiedColumn) {
      console.log("[Migration] Adding email_verified column to users table");
      db.exec(`
        ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1;
      `);
    }

    if (!hasImageColumn) {
      console.log("[Migration] Adding image column to users table");
      db.exec(`
        ALTER TABLE users ADD COLUMN image TEXT;
      `);
    }

    db.exec(`
      UPDATE users
      SET
        updated_at = COALESCE(updated_at, created_at),
        email_verified = COALESCE(email_verified, 1)
      WHERE updated_at IS NULL OR email_verified IS NULL;
    `);

    // Migration: store video lengths as seconds.
    //
    // `duration` holds YouTube's display string, which cannot be summed and
    // which the RSS fetcher never provides. `duration_seconds` is the value
    // everything reads; `duration_attempts` bounds the per-video backfill so
    // videos that will never yield a length are not refetched forever.
    const videosInfo = db.pragma("table_info(videos)") as Array<any>;
    const hasDurationSeconds = videosInfo.some(
      (col: any) => col.name === "duration_seconds",
    );
    const hasDurationAttempts = videosInfo.some(
      (col: any) => col.name === "duration_attempts",
    );

    if (!hasDurationSeconds) {
      console.log("[Migration] Adding duration_seconds column to videos table");
      db.exec("ALTER TABLE videos ADD COLUMN duration_seconds INTEGER;");

      // Convert the display strings we already have. Only the M:SS and H:MM:SS
      // forms are recognised; anything else stays NULL and the backfill picks
      // it up rather than the parser guessing.
      const rows = db
        .prepare(
          "SELECT video_id, duration FROM videos WHERE duration IS NOT NULL AND duration_seconds IS NULL",
        )
        .all() as Array<{ video_id: string; duration: string }>;

      const update = db.prepare(
        "UPDATE videos SET duration_seconds = ? WHERE video_id = ?",
      );
      let converted = 0;

      db.transaction(() => {
        for (const row of rows) {
          const seconds = parseDurationText(row.duration);
          if (seconds !== null) {
            update.run(seconds, row.video_id);
            converted++;
          }
        }
      })();

      console.log(
        `[Migration] Converted ${converted}/${rows.length} stored durations to seconds`,
      );
    }

    if (!hasDurationAttempts) {
      console.log(
        "[Migration] Adding duration_attempts column to videos table",
      );
      db.exec(
        "ALTER TABLE videos ADD COLUMN duration_attempts INTEGER NOT NULL DEFAULT 0;",
      );
    }

    // Migration: Make playback_history user-scoped
    // Check if playback_history has user_id column
    const playbackHistoryInfo = db.pragma(
      "table_info(playback_history)",
    ) as Array<any>;
    const hasUserIdColumn = playbackHistoryInfo.some(
      (col: any) => col.name === "user_id",
    );

    if (!hasUserIdColumn) {
      console.log(
        "[Migration] Adding user_id to playback_history (making it user-scoped)",
      );
      try {
        // Backup data (without user association since old data has no user_id)
        const backupData = db
          .prepare(
            "SELECT video_id, video_title, channel_id, channel_name, thumbnail, timestamp, duration, progress, completed FROM playback_history",
          )
          .all();

        // Drop old table
        db.exec("DROP TABLE IF EXISTS playback_history");

        // Recreate table with user_id
        db.exec(`
          CREATE TABLE playback_history (
            video_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            video_title TEXT NOT NULL,
            channel_id TEXT,
            channel_name TEXT NOT NULL,
            thumbnail TEXT,
            timestamp TEXT NOT NULL,
            duration REAL NOT NULL,
            progress REAL NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (video_id, user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
          
          CREATE INDEX idx_playback_history_user_id 
          ON playback_history(user_id);
          
          CREATE INDEX idx_playback_history_timestamp 
          ON playback_history(timestamp DESC);
        `);

        // Note: We don't restore old data since we can't associate it with users
        // This is acceptable as playback history is non-critical data
        console.log(
          `[Migration] Recreated playback_history with user_id (cleared ${backupData.length} unattributable entries)`,
        );
      } catch (error) {
        console.error("[Migration] Error migrating playback_history:", error);
      }
    }

    // Migration: Mark welcome wizard as completed for all users
    if (process.env.CLI_MODE !== "true") {
      console.log("[Migration] Ensuring welcome wizard is marked as completed");
    }
    const users = db.prepare("SELECT id FROM users").all() as Array<{
      id: string;
    }>;
    const configStmt = db.prepare(
      "INSERT OR REPLACE INTO user_config (user_id, key, value) VALUES (?, ?, ?)",
    );

    for (const user of users) {
      // Check if welcome config already exists
      const existing = db
        .prepare("SELECT value FROM user_config WHERE user_id = ? AND key = ?")
        .get(user.id, "hasCompletedWelcome") as { value: string } | undefined;

      if (!existing) {
        if (process.env.CLI_MODE !== "true") {
          console.log(
            `[Migration] Setting hasCompletedWelcome for user ${user.id}`,
          );
        }
        configStmt.run(user.id, "hasCompletedWelcome", JSON.stringify(true));
      }
    }
  } catch (error) {
    console.error("[Migration] Error running migrations:", error);
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Helper to check if database exists and has data
export function databaseExists(): boolean {
  return existsSync(dbPath);
}
