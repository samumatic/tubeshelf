import { randomUUID } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// TUBESHELF_TEST_DB_PATH must be set before lib/db.ts is first imported (it
// reads the env var once, at module load, to decide where to open the
// database) - so this has to happen before any of these imports resolve.
process.env.TUBESHELF_TEST_DB_PATH = ":memory:";

const { getDb } = await import("./db");
const {
  clearVideoCache,
  clearVideoCacheForChannels,
  countCachedVideos,
  effectiveRetentionDays,
  getCachedVideos,
  getChannelFetchStates,
  getChannelRetentionWindows,
  markChannelFetched,
  pruneVideos,
  upsertVideos,
} = await import("./videoCacheStore");

beforeEach(() => {
  // Fresh schema per test: getDb() is a module-level singleton, so instead of
  // a new in-memory database each time, clear every table it created.
  const db = getDb();
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    db.exec(`DELETE FROM "${name.replace(/"/g, '""')}"`);
  }
});

function video(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: randomUUID(),
    channelId: "UCchannel",
    channelTitle: "Some Channel",
    title: "A video",
    publishedAt: "2026-08-01T00:00:00.000Z",
    thumbnail: "https://i.ytimg.com/vi/x/hqdefault.jpg",
    duration: "4:20",
    viewCount: 100,
    isMemberOnly: false,
    ...overrides,
  };
}

describe("upsertVideos / getCachedVideos", () => {
  it("round-trips a video through the cache", () => {
    upsertVideos("UCchannel", [video({ id: "v1", title: "Hello" })]);

    const [cached] = getCachedVideos(["UCchannel"]);
    expect(cached.videoId).toBe("v1");
    expect(cached.title).toBe("Hello");
    expect(cached.channelTitle).toBe("Some Channel");
  });

  it("keeps the original first_seen_at across re-fetches", () => {
    upsertVideos("UCchannel", [video({ id: "v1" })]);
    const firstSeenAt1 = getCachedVideos(["UCchannel"])[0].firstSeenAt;

    // Re-upsert the same video later; first_seen_at must not move.
    upsertVideos("UCchannel", [video({ id: "v1", title: "Updated title" })]);
    const [cached] = getCachedVideos(["UCchannel"]);

    expect(cached.firstSeenAt).toBe(firstSeenAt1);
    expect(cached.title).toBe("Updated title"); // mutable fields still refresh
  });

  it("keeps the earliest known published_at on conflict", () => {
    upsertVideos("UCchannel", [
      video({ id: "v1", publishedAt: "2026-08-05T00:00:00.000Z" }),
    ]);
    upsertVideos("UCchannel", [
      video({ id: "v1", publishedAt: "2026-08-01T00:00:00.000Z" }),
    ]);

    const [cached] = getCachedVideos(["UCchannel"]);
    expect(cached.publishedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("keeps a stored value instead of overwriting it with a missing one", () => {
    // RSS has no duration/members-only flag; a later RSS-sourced upsert must
    // not blank out what an earlier standard-fetch upsert already learned.
    upsertVideos("UCchannel", [
      video({ id: "v1", duration: "4:20", isMemberOnly: true }),
    ]);
    upsertVideos("UCchannel", [
      video({ id: "v1", duration: undefined, isMemberOnly: undefined }),
    ]);

    const [cached] = getCachedVideos(["UCchannel"]);
    expect(cached.duration).toBe("4:20");
    expect(cached.isMemberOnly).toBe(true);
  });

  it("filters by retention window", () => {
    upsertVideos("UCchannel", [
      video({ id: "old", publishedAt: "2020-01-01T00:00:00.000Z" }),
      video({ id: "new", publishedAt: new Date().toISOString() }),
    ]);

    const recentOnly = getCachedVideos(["UCchannel"], 30);
    expect(recentOnly.map((v) => v.videoId)).toEqual(["new"]);

    const everything = getCachedVideos(["UCchannel"], 0);
    expect(everything.map((v) => v.videoId).sort()).toEqual(["new", "old"]);
  });

  it("ignores videos with no id", () => {
    const written = upsertVideos("UCchannel", [video({ id: "" })]);
    expect(written).toBe(0);
    expect(getCachedVideos(["UCchannel"])).toHaveLength(0);
  });

  it("returns nothing for an empty channel list", () => {
    expect(getCachedVideos([])).toEqual([]);
  });
});

describe("countCachedVideos", () => {
  it("counts across multiple channels without double-counting duplicates", () => {
    upsertVideos("UCa", [video({ id: "v1", channelId: "UCa" })]);
    upsertVideos("UCb", [video({ id: "v2", channelId: "UCb" })]);

    expect(countCachedVideos(["UCa", "UCb", "UCa"])).toBe(2);
  });
});

describe("channel fetch state", () => {
  it("records a successful fetch", () => {
    markChannelFetched("UCchannel", { videoCount: 5 });

    const states = getChannelFetchStates(["UCchannel"]);
    const state = states.get("UCchannel");
    expect(state?.videoCount).toBe(5);
    expect(state?.lastError).toBeNull();
    expect(state?.lastFetchedAt).toBe(state?.lastSuccessAt);
  });

  it("records a failure without clobbering the last success time", () => {
    markChannelFetched("UCchannel", { videoCount: 5 });
    const successAt = getChannelFetchStates(["UCchannel"]).get(
      "UCchannel"
    )?.lastSuccessAt;

    markChannelFetched("UCchannel", { videoCount: 0, error: "boom" });
    const state = getChannelFetchStates(["UCchannel"]).get("UCchannel");

    expect(state?.lastError).toBe("boom");
    expect(state?.lastSuccessAt).toBe(successAt); // unchanged by the failure
  });
});

describe("clearVideoCache", () => {
  it("removes every cached video and reports how many", () => {
    upsertVideos("UCchannel", [video({ id: "v1" }), video({ id: "v2" })]);
    upsertVideos("UCother", [video({ id: "v3", channelId: "UCother" })]);

    const result = clearVideoCache();

    expect(result.videosCleared).toBe(3);
    expect(getCachedVideos(["UCchannel", "UCother"])).toEqual([]);
  });

  it("resets fetch bookkeeping so every channel is treated as stale again", () => {
    markChannelFetched("UCchannel", { videoCount: 5 });

    const result = clearVideoCache();

    expect(result.channelsReset).toBe(1);
    expect(getChannelFetchStates(["UCchannel"]).size).toBe(0);
  });

  it("does not touch subscriptions or other unrelated tables", () => {
    const db = getDb();
    db.exec(
      `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL)`
    );
    db.prepare("INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)").run(
      "u1",
      "u1@example.com"
    );
    db.prepare(
      "INSERT OR IGNORE INTO subscription_lists (id, name, user_id) VALUES ('u1-list', 'Default', 'u1')"
    ).run();
    db.prepare(
      "INSERT OR IGNORE INTO subscriptions (list_id, channel_id, title, url, added_at) VALUES ('u1-list', 'UCchannel', 'x', 'https://x', datetime('now'))"
    ).run();
    upsertVideos("UCchannel", [video({ id: "v1" })]);

    clearVideoCache();

    const subCount = (
      db.prepare("SELECT COUNT(*) as n FROM subscriptions").get() as {
        n: number;
      }
    ).n;
    expect(subCount).toBe(1);
  });

  it("returns zero counts when the cache is already empty", () => {
    expect(clearVideoCache()).toEqual({ videosCleared: 0, channelsReset: 0 });
  });
});

describe("clearVideoCacheForChannels", () => {
  it("only clears videos and fetch state for the given channels", () => {
    upsertVideos("UCa", [video({ id: "v1", channelId: "UCa" })]);
    upsertVideos("UCb", [video({ id: "v2", channelId: "UCb" })]);
    markChannelFetched("UCa", { videoCount: 1 });
    markChannelFetched("UCb", { videoCount: 1 });

    const result = clearVideoCacheForChannels(["UCa"]);

    expect(result).toEqual({ videosCleared: 1, channelsReset: 1 });
    expect(getCachedVideos(["UCa"])).toEqual([]);
    expect(getCachedVideos(["UCb"]).map((v) => v.videoId)).toEqual(["v2"]);
    expect(getChannelFetchStates(["UCa"]).size).toBe(0);
    expect(getChannelFetchStates(["UCb"]).size).toBe(1);
  });

  it("returns zero counts for an empty or all-falsy channel list", () => {
    expect(clearVideoCacheForChannels([])).toEqual({
      videosCleared: 0,
      channelsReset: 0,
    });
    expect(clearVideoCacheForChannels(["", undefined as any])).toEqual({
      videosCleared: 0,
      channelsReset: 0,
    });
  });

  it("de-duplicates repeated channel ids", () => {
    upsertVideos("UCa", [video({ id: "v1", channelId: "UCa" })]);

    const result = clearVideoCacheForChannels(["UCa", "UCa", "UCa"]);

    expect(result.videosCleared).toBe(1);
  });
});

describe("effectiveRetentionDays", () => {
  it("prefers the user override when present", () => {
    expect(effectiveRetentionDays(30, 270)).toBe(30);
    expect(effectiveRetentionDays(0, 270)).toBe(0); // 0 = forever, not falsy-fallback
  });

  it("falls back to the instance default when unset", () => {
    expect(effectiveRetentionDays(null, 270)).toBe(270);
    expect(effectiveRetentionDays(undefined, 270)).toBe(270);
  });
});

describe("retention windows and pruning", () => {
  function seedUserAndSubscription(
    userId: string,
    channelId: string,
    retentionDays?: number
  ) {
    const db = getDb();
    db.exec(
      `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL)`
    );
    db.prepare(
      "INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)"
    ).run(userId, `${userId}@example.com`);

    const listId = `${userId}-list`;
    db.prepare(
      "INSERT OR IGNORE INTO subscription_lists (id, name, user_id) VALUES (?, 'Default', ?)"
    ).run(listId, userId);
    db.prepare(
      "INSERT OR IGNORE INTO subscriptions (list_id, channel_id, title, url, added_at) VALUES (?, ?, 'x', 'https://x', datetime('now'))"
    ).run(listId, channelId);

    if (retentionDays !== undefined) {
      db.prepare(
        "INSERT OR REPLACE INTO user_config (user_id, key, value) VALUES (?, 'videoRetentionDays', ?)"
      ).run(userId, JSON.stringify(retentionDays));
    }
  }

  it("uses the instance default when nobody overrides it", () => {
    seedUserAndSubscription("u1", "UCchannel");
    const windows = getChannelRetentionWindows(270);
    expect(windows.get("UCchannel")).toBe(270);
  });

  it("the most generous subscriber wins, and forever always wins", () => {
    seedUserAndSubscription("u1", "UCchannel", 30);
    seedUserAndSubscription("u2", "UCchannel", 90);
    expect(getChannelRetentionWindows(270).get("UCchannel")).toBe(90);

    seedUserAndSubscription("u3", "UCchannel", 0); // forever
    expect(getChannelRetentionWindows(270).get("UCchannel")).toBe(0);
  });

  it("deletes only videos past their channel's window", () => {
    seedUserAndSubscription("u1", "UCchannel", 30);
    upsertVideos("UCchannel", [
      video({ id: "old", publishedAt: "2020-01-01T00:00:00.000Z" }),
      video({ id: "new", publishedAt: new Date().toISOString() }),
    ]);

    const deleted = pruneVideos(270);

    expect(deleted).toBe(1);
    expect(getCachedVideos(["UCchannel"], 0).map((v) => v.videoId)).toEqual([
      "new",
    ]);
  });

  it("never deletes anything for a channel with a forever subscriber", () => {
    seedUserAndSubscription("u1", "UCchannel", 0);
    upsertVideos("UCchannel", [
      video({ id: "ancient", publishedAt: "2000-01-01T00:00:00.000Z" }),
    ]);

    expect(pruneVideos(270)).toBe(0);
  });
});
