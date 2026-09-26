import { beforeEach, describe, expect, it } from "vitest";

// Must be set before lib/db.ts is first imported (see videoCacheStore.test.ts).
process.env.TUBESHELF_TEST_DB_PATH = ":memory:";

const { getDb } = await import("./db");
const { extractApiKey, isApiKeyAllowedPath } = await import("./apiKeyHeaders");
const {
  createApiKey,
  hashApiKey,
  listApiKeys,
  resolveApiKeyUser,
  revokeApiKey,
  MAX_API_KEYS_PER_USER,
} = await import("./apiKeyStore");
const { readLists, syncListsFromSnapshot, addSubscriptionToList, createList } =
  await import("./subscriptionListStore");

const ALPHA = "UCaaaaaaaaaaaaaaaaaaaaaa";
const BRAVO = "UCbbbbbbbbbbbbbbbbbbbbbb";
const CHARLIE = "UCcccccccccccccccccccccc";

function addUser(id: string, isAdmin = false) {
  getDb()
    .prepare("INSERT INTO users (id, email, name, is_admin) VALUES (?, ?, ?, ?)")
    .run(id, `${id}@example.test`, id, isAdmin ? 1 : 0);
}

beforeEach(() => {
  const db = getDb();
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as Array<{ name: string }>;
  db.exec("PRAGMA foreign_keys = OFF");
  for (const { name } of tables) {
    db.exec(`DELETE FROM "${name.replace(/"/g, '""')}"`);
  }
  db.exec("PRAGMA foreign_keys = ON");
  addUser("u1", true);
  addUser("u2");
});

describe("extractApiKey", () => {
  it("reads X-API-Key and tsk_ Bearer tokens", () => {
    expect(extractApiKey(new Headers({ "x-api-key": " tsk_abc " }))).toBe("tsk_abc");
    expect(extractApiKey(new Headers({ authorization: "Bearer tsk_abc" }))).toBe("tsk_abc");
    expect(extractApiKey(new Headers({ authorization: "bearer tsk_abc" }))).toBe("tsk_abc");
  });

  it("ignores other Bearer tokens and missing headers", () => {
    expect(extractApiKey(new Headers({ authorization: "Bearer eyJhbGciOi" }))).toBeNull();
    expect(extractApiKey(new Headers({ authorization: "Basic dXNlcjpwYXNz" }))).toBeNull();
    expect(extractApiKey(new Headers())).toBeNull();
  });
});

describe("isApiKeyAllowedPath", () => {
  it("allows only subscription endpoints", () => {
    expect(isApiKeyAllowedPath("/api/subscriptions")).toBe(true);
    expect(isApiKeyAllowedPath("/api/subscriptions/export")).toBe(true);
    expect(isApiKeyAllowedPath("/api/subscription-lists")).toBe(true);
    expect(isApiKeyAllowedPath("/api/subscription-lists/subscriptions")).toBe(true);
  });

  it("blocks account, admin, and key-management routes", () => {
    for (const path of [
      "/api/user/api-keys",
      "/api/user/password",
      "/api/admin/users",
      "/api/danger/delete-account",
      "/api/settings",
      "/api/subscriptions-evil",
      "/",
    ]) {
      expect(isApiKeyAllowedPath(path)).toBe(false);
    }
  });
});

describe("api key store", () => {
  it("creates a key, stores only its hash, and resolves it to its user", () => {
    const { key, apiKey } = createApiKey("u1", "  SubRelay   sync ");
    expect(key.startsWith("tsk_")).toBe(true);
    expect(apiKey.name).toBe("SubRelay sync");
    expect(key.startsWith(apiKey.prefix)).toBe(true);

    const row = getDb().prepare("SELECT key_hash FROM api_keys").get() as { key_hash: string };
    expect(row.key_hash).toBe(hashApiKey(key));
    expect(JSON.stringify(getDb().prepare("SELECT * FROM api_keys").all())).not.toContain(key);

    expect(resolveApiKeyUser(key)?.id).toBe("u1");
    expect(listApiKeys("u1")[0].lastUsedAt).not.toBeNull();
    expect(listApiKeys("u2")).toHaveLength(0);
  });

  it("rejects unknown and revoked keys", () => {
    const { key, apiKey } = createApiKey("u1", "temp");
    expect(resolveApiKeyUser(`${key}x`)).toBeNull();
    expect(resolveApiKeyUser("not-a-key")).toBeNull();

    expect(revokeApiKey("u2", apiKey.id)).toBe(false); // someone else's key
    expect(resolveApiKeyUser(key)?.id).toBe("u1");
    expect(revokeApiKey("u1", apiKey.id)).toBe(true);
    expect(resolveApiKeyUser(key)).toBeNull();
  });

  it("requires a name and caps keys per user", () => {
    expect(() => createApiKey("u1", "   ")).toThrow(/name/);
    for (let i = 0; i < MAX_API_KEYS_PER_USER; i++) createApiKey("u1", `k${i}`);
    expect(() => createApiKey("u1", "one too many")).toThrow(/at most/);
  });

  it("removes keys with their user", () => {
    const { key } = createApiKey("u2", "doomed");
    getDb().prepare("DELETE FROM users WHERE id = ?").run("u2");
    expect(resolveApiKeyUser(key)).toBeNull();
  });
});

function memberships(lists: Awaited<ReturnType<typeof readLists>>) {
  return Object.fromEntries(
    lists.lists.map((list) => [
      list.name,
      list.subscriptions.map((sub) => sub.channelId).sort(),
    ])
  );
}

describe("syncListsFromSnapshot", () => {
  it("maps groups onto lists, creating them by name", async () => {
    const result = await syncListsFromSnapshot("u1", [
      { channelId: ALPHA, title: "Alpha", groups: ["Tech", "Science"] },
      { channelId: BRAVO, title: "Bravo", groups: [] },
    ]);
    expect(result.createdLists.sort()).toEqual(["Science", "Tech"]);
    expect(memberships(await readLists("u1"))).toEqual({
      Default: [BRAVO],
      Tech: [ALPHA],
      Science: [ALPHA],
    });
  });

  it("mirrors a later snapshot without deleting lists or touching other users", async () => {
    await readLists("u1"); // creates the default list, as the app does on first load
    await createList("Cooking", "u1");
    const lists = await readLists("u1");
    const cooking = lists.lists.find((l) => l.name === "Cooking")!;
    const now = new Date().toISOString();
    await addSubscriptionToList(cooking.id, { id: CHARLIE, channelId: CHARLIE, title: "Charlie", url: "", addedAt: now }, "u1");
    await addSubscriptionToList(lists.defaultListId, { id: ALPHA, channelId: ALPHA, title: "Alpha", url: "", addedAt: now }, "u1");
    await syncListsFromSnapshot("u2", [{ channelId: CHARLIE, title: "Charlie", groups: ["Cooking"] }]);

    // "cooking" matches the existing list case-insensitively; Charlie isn't in
    // the snapshot so it's removed; Alpha keeps its default-list entry.
    const result = await syncListsFromSnapshot("u1", [
      { channelId: ALPHA, title: "Alpha", groups: ["cooking"] },
    ]);
    expect(result.createdLists).toEqual([]);
    expect(result.removed).toBe(1);
    expect(memberships(await readLists("u1"))).toEqual({
      Default: [ALPHA],
      Cooking: [ALPHA],
    });
    expect(memberships(await readLists("u2")).Cooking).toEqual([CHARLIE]);
  });

  it("moves a channel out of lists it's no longer grouped into", async () => {
    await syncListsFromSnapshot("u1", [{ channelId: ALPHA, title: "Alpha", groups: ["Tech"] }]);
    await syncListsFromSnapshot("u1", [{ channelId: ALPHA, title: "Alpha", groups: [] }]);
    expect(memberships(await readLists("u1"))).toEqual({ Default: [ALPHA], Tech: [] });
  });

  it("recreates a missing default list for ungrouped channels", async () => {
    await createList("Tech", "u1"); // user has lists, but no default list
    await syncListsFromSnapshot("u1", [{ channelId: BRAVO, title: "Bravo", groups: [] }]);
    expect(memberships(await readLists("u1"))).toEqual({ Tech: [], Default: [BRAVO] });
  });
});
