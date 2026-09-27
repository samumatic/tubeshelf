import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must be set before lib/db.ts is first imported (see videoCacheStore.test.ts).
process.env.TUBESHELF_TEST_DB_PATH = ":memory:";

const { getDb } = await import("./db");
const { addWatched, listWatched, parseWatchedBody } = await import("./watchedStore");
const { mergeListsFromSnapshot, readLists, createList, addSubscriptionToList } =
  await import("./subscriptionListStore");
const {
  getSubRelaySyncSettings,
  normalizeSubRelayUrl,
  runSubRelaySync,
  saveSubRelaySyncSettings,
} = await import("./subrelaySync");

const ALPHA = "UCaaaaaaaaaaaaaaaaaaaaaa";
const BRAVO = "UCbbbbbbbbbbbbbbbbbbbbbb";
const CHARLIE = "UCcccccccccccccccccccccc";
const V1 = "aaaaaaaaaaa";
const V2 = "bbbbbbbbbbb";
const V3 = "ccccccccccc";

beforeEach(() => {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  db.exec("PRAGMA foreign_keys = OFF");
  for (const { name } of tables) db.exec(`DELETE FROM "${name.replace(/"/g, '""')}"`);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'u1@example.test', 'u1')").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function memberships(lists: Awaited<ReturnType<typeof readLists>>) {
  return Object.fromEntries(
    lists.lists.map((list) => [list.name, list.subscriptions.map((sub) => sub.channelId).sort()])
  );
}

describe("watched store", () => {
  it("adds watched videos without touching existing ones", () => {
    expect(addWatched("u1", [{ videoId: V1, watchedAt: "2026-01-01T00:00:00Z" }])).toBe(1);
    expect(addWatched("u1", [{ videoId: V1, watchedAt: "2026-06-01T00:00:00Z" }, { videoId: V2 }, { videoId: "bad" }])).toBe(1);
    const watched = listWatched("u1");
    expect(watched.map((w) => w.videoId).sort()).toEqual([V1, V2]);
    expect(watched.find((w) => w.videoId === V1)?.watchedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("parses array and object bodies", () => {
    expect(parseWatchedBody([V1, { videoId: V2, watchedAt: "x" }, "nope"])).toEqual([
      { videoId: V1, watchedAt: "" },
      { videoId: V2, watchedAt: "x" },
    ]);
    expect(parseWatchedBody({ watched: [V3] })).toEqual([{ videoId: V3, watchedAt: "" }]);
    expect(parseWatchedBody({ nope: [] })).toBeNull();
  });
});

describe("mergeListsFromSnapshot", () => {
  it("only adds: new channels, new lists, and new memberships", async () => {
    await readLists("u1");
    await createList("Tech", "u1");
    const lists = await readLists("u1");
    const tech = lists.lists.find((l) => l.name === "Tech")!;
    await addSubscriptionToList(tech.id, { id: ALPHA, channelId: ALPHA, title: "Alpha", url: "", addedAt: "" }, "u1");

    const result = await mergeListsFromSnapshot("u1", [
      { channelId: ALPHA, title: "Alpha", groups: ["Science"] }, // known: gains a list, keeps Tech
      { channelId: BRAVO, title: "Bravo", groups: [] }, // new, ungrouped -> Default
      { channelId: CHARLIE, title: "Charlie", groups: ["tech"] }, // new, existing list by name
    ]);
    expect(result).toEqual({ createdLists: ["Science"], addedChannels: 2, addedMemberships: 3 });
    expect(memberships(await readLists("u1"))).toEqual({
      Default: [BRAVO],
      Tech: [ALPHA, CHARLIE],
      Science: [ALPHA],
    });
  });
});

describe("SubRelay sync settings", () => {
  it("normalizes and validates the URL", () => {
    expect(normalizeSubRelayUrl(" subrelay.example/ ")).toBe("https://subrelay.example");
    expect(normalizeSubRelayUrl("http://subrelay:5173/?x=1#y")).toBe("http://subrelay:5173");
    expect(normalizeSubRelayUrl("")).toBe("");
    expect(() => normalizeSubRelayUrl("ftp://x")).toThrow();
    expect(() => normalizeSubRelayUrl("http://169.254.169.254")).toThrow(/metadata/);
    expect(() => normalizeSubRelayUrl("http://user:pw@subrelay")).toThrow(/API key/);
  });

  it("keeps the key write-only and drops it when the host changes", () => {
    let settings = saveSubRelaySyncSettings("u1", { url: "http://subrelay:5173", apiKey: "srk_one" });
    expect(settings).toMatchObject({ url: "http://subrelay:5173", hasApiKey: true, syncWatched: true });
    expect(JSON.stringify(settings)).not.toContain("srk_one");

    settings = saveSubRelaySyncSettings("u1", { url: "http://subrelay:5173/", syncWatched: false });
    expect(settings).toMatchObject({ hasApiKey: true, syncWatched: false });

    settings = saveSubRelaySyncSettings("u1", { url: "http://elsewhere:5173" });
    expect(settings.hasApiKey).toBe(false);

    saveSubRelaySyncSettings("u1", { url: "http://elsewhere:5173", apiKey: "srk_two" });
    expect(saveSubRelaySyncSettings("u1", { url: "http://elsewhere:5173", clearApiKey: true }).hasApiKey).toBe(false);
  });
});

type Call = { method: string; path: string; auth: string | null; body: any };

/** A fake SubRelay: canWrite=false answers writes like a non-admin key. */
function stubSubRelay({ canWrite = true, hasWatchedApi = true } = {}) {
  const calls: Call[] = [];
  const subrelaySubs = [
    { channelId: BRAVO, title: "Bravo", groups: ["Science"] },
    { channelId: "@not-a-channel-id", title: "Skipped", groups: [] },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({
        method,
        path: url.pathname + url.search,
        auth: new Headers(init.headers).get("authorization"),
        body,
      });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

      if (url.pathname === "/api/sync/subscriptions" && method === "GET") {
        return json(200, { subscriptions: subrelaySubs });
      }
      if (url.pathname === "/api/sync/subscriptions" && method === "POST") {
        return canWrite ? json(200, { diff: { summary: { added: 1 } } }) : json(403, { error: "admin api key required" });
      }
      if (url.pathname === "/api/sync/watched" && !hasWatchedApi) return json(404, { error: "not found" });
      if (url.pathname === "/api/sync/watched" && method === "GET") {
        return json(200, { watched: [{ videoId: V2, watchedAt: "2026-02-01T00:00:00Z" }, { videoId: "bad" }] });
      }
      if (url.pathname === "/api/sync/watched" && method === "POST") {
        return canWrite ? json(200, { added: 1 }) : json(403, { error: "admin api key required" });
      }
      return json(404, { error: "not found" });
    })
  );
  return calls;
}

describe("runSubRelaySync", () => {
  beforeEach(async () => {
    await readLists("u1");
    const lists = await readLists("u1");
    await addSubscriptionToList(lists.defaultListId, { id: ALPHA, channelId: ALPHA, title: "Alpha", url: "", addedAt: "" }, "u1");
    addWatched("u1", [{ videoId: V1 }]);
    saveSubRelaySyncSettings("u1", { url: "http://subrelay:5173", apiKey: "srk_admin" });
  });

  it("merges both ways and sends the key only to SubRelay", async () => {
    const calls = stubSubRelay();
    const result = await runSubRelaySync("u1");

    expect(result.status).toBe("success");
    expect(result.subscriptions).toMatchObject({ pulled: 1, addedHere: 1, sent: 2, addedThere: 1, createdLists: ["Science"] });
    expect(result.watched).toEqual({ pulled: 1, addedHere: 1, sent: 2, addedThere: 1 });
    expect(memberships(await readLists("u1"))).toEqual({ Default: [ALPHA], Science: [BRAVO] });
    expect(listWatched("u1").map((w) => w.videoId).sort()).toEqual([V1, V2]);

    expect(calls.every((call) => call.auth === "Bearer srk_admin")).toBe(true);
    const pushedSubs = calls.find((c) => c.method === "POST" && c.path === "/api/sync/subscriptions")!.body;
    expect(pushedSubs.mode).toBe("merge");
    expect(pushedSubs.subscriptions).toEqual(
      expect.arrayContaining([
        { channelId: ALPHA, title: "Alpha", groups: [] },
        { channelId: BRAVO, title: "Bravo", groups: ["Science"] },
      ])
    );

    expect(getSubRelaySyncSettings("u1")).toMatchObject({ lastStatus: "success" });
  });

  it("still pulls with a read-only key and reports it", async () => {
    const calls = stubSubRelay({ canWrite: false });
    const result = await runSubRelaySync("u1");

    expect(result.status).toBe("partial");
    expect(result.subscriptions.addedHere).toBe(1);
    expect(result.subscriptions.addedThere).toBeNull();
    expect(result.watched?.addedHere).toBe(1);
    expect(result.warnings[0]).toMatch(/admin/);
    // After the first 403 it doesn't keep trying to write.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(getSubRelaySyncSettings("u1").lastStatus).toBe("partial");
  });

  it("tolerates a SubRelay without the watched API", async () => {
    stubSubRelay({ hasWatchedApi: false });
    const result = await runSubRelaySync("u1");
    expect(result.status).toBe("partial");
    expect(result.watched).toBeNull();
    expect(result.warnings.join(" ")).toMatch(/update SubRelay/);
  });

  it("records an error for an unreachable SubRelay or a bad key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(runSubRelaySync("u1")).rejects.toThrow(/could not be reached/);
    expect(getSubRelaySyncSettings("u1").lastStatus).toBe("error");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(runSubRelaySync("u1")).rejects.toThrow(/rejected the API key/);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    await expect(runSubRelaySync("u1")).rejects.toThrow(/other than JSON/);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { Location: "/login" } })));
    await expect(runSubRelaySync("u1")).rejects.toThrow(/redirected/);
  });

  it("requires a URL and key", async () => {
    saveSubRelaySyncSettings("u1", { url: "http://subrelay:5173", clearApiKey: true });
    await expect(runSubRelaySync("u1")).rejects.toThrow(/API key first/);
  });
});
