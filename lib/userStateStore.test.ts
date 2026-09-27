import { beforeEach, describe, expect, it } from "vitest";

// Must be set before lib/db.ts is first imported (see videoCacheStore.test.ts).
process.env.TUBESHELF_TEST_DB_PATH = ":memory:";

const { getDb } = await import("./db");
const { readUserState, writeUserState } = await import("./userStateStore");

const USER = "u1";
const OLD = "2026-01-01T00:00:00.000Z";

function watchedAtById(userId = USER): Record<string, string> {
  const rows = getDb()
    .prepare("SELECT video_id, watched_at FROM watched_videos WHERE user_id = ?")
    .all(userId) as Array<{ video_id: string; watched_at: string }>;
  return Object.fromEntries(rows.map((row) => [row.video_id, row.watched_at]));
}

function configValue(key: string, userId = USER): string | undefined {
  const row = getDb()
    .prepare("SELECT value FROM user_config WHERE user_id = ? AND key = ?")
    .get(userId, key) as { value: string } | undefined;
  return row?.value;
}

beforeEach(() => {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  db.exec("PRAGMA foreign_keys = OFF");
  for (const { name } of tables) db.exec(`DELETE FROM "${name.replace(/"/g, '""')}"`);
  db.exec("PRAGMA foreign_keys = ON");
  for (const id of [USER, "u2"]) {
    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(id, `${id}@example.test`);
  }
});

describe("writeUserState", () => {
  it("keeps user_config keys it doesn't own", async () => {
    const tags = JSON.stringify({ UCaaaaaaaaaaaaaaaaaaaaaa: ["music"] });
    getDb()
      .prepare("INSERT INTO user_config (user_id, key, value) VALUES (?, ?, ?)")
      .run(USER, "subscriptionTags", tags);

    const state = await readUserState(USER);
    await writeUserState({ ...state, hideWatched: true }, USER);

    expect(configValue("subscriptionTags")).toBe(tags);
    expect((await readUserState(USER)).hideWatched).toBe(true);
  });

  it("updates the keys it owns in place", async () => {
    const state = await readUserState(USER);
    await writeUserState({ ...state, filterListId: "list-a", hideShorts: false }, USER);
    await writeUserState({ ...state, filterListId: "list-b", hideShorts: false }, USER);

    const after = await readUserState(USER);
    expect(after.filterListId).toBe("list-b");
    expect(after.hideShorts).toBe(false);
    const count = getDb()
      .prepare("SELECT COUNT(*) AS count FROM user_config WHERE user_id = ? AND key = 'filterListId'")
      .get(USER) as { count: number };
    expect(count.count).toBe(1);
  });

  it("keeps existing watched_at, adds new videos, and removes un-watched ones", async () => {
    const insert = getDb().prepare(
      "INSERT INTO watched_videos (video_id, user_id, watched_at) VALUES (?, ?, ?)"
    );
    insert.run("keepkeepkee", USER, OLD);
    insert.run("dropdropdro", USER, OLD);
    insert.run("otheruservd", "u2", OLD);

    const before = Date.now();
    const state = await readUserState(USER);
    await writeUserState({ ...state, watchedVideos: ["keepkeepkee", "newnewnewnw"] }, USER);

    const watched = watchedAtById();
    expect(Object.keys(watched).sort()).toEqual(["keepkeepkee", "newnewnewnw"]);
    expect(watched.keepkeepkee).toBe(OLD);
    expect(Date.parse(watched.newnewnewnw)).toBeGreaterThanOrEqual(before);
    // Another user's rows are untouched.
    expect(watchedAtById("u2")).toEqual({ otheruservd: OLD });
  });

  it("clears watch history when given an empty list", async () => {
    getDb()
      .prepare("INSERT INTO watched_videos (video_id, user_id, watched_at) VALUES (?, ?, ?)")
      .run("keepkeepkee", USER, OLD);
    const state = await readUserState(USER);
    await writeUserState({ ...state, watchedVideos: [] }, USER);
    expect(watchedAtById()).toEqual({});
  });

  it("tolerates duplicate ids in the incoming list", async () => {
    const state = await readUserState(USER);
    await writeUserState({ ...state, watchedVideos: ["dupdupdupdu", "dupdupdupdu"] }, USER);
    expect(Object.keys(watchedAtById())).toEqual(["dupdupdupdu"]);
  });
});
