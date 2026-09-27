import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must be set before lib/db.ts is first imported (see videoCacheStore.test.ts).
process.env.TUBESHELF_TEST_DB_PATH = ":memory:";

const { getDb } = await import("./db");
const { addWatchedIds, listWatchedIds, parseWatchedIds } = await import("./watchedStore");
const { mergeListsFromSnapshot, readLists, createList, addSubscriptionToList } =
  await import("./subscriptionListStore");
const {
  FEED_WATCHED_SYNC_MIN_INTERVAL_MS,
  getSubRelaySyncSettings,
  normalizeSubRelayUrl,
  runFeedWatchedSync,
  runSubRelaySync,
  saveSubRelaySyncSettings,
  subRelayRetry,
} = await import("./subrelaySync");

subRelayRetry.baseDelayMs = 1;

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
  it("adds watched ids without touching existing ones", () => {
    getDb()
      .prepare("INSERT INTO watched_videos (video_id, user_id, watched_at) VALUES (?, ?, ?)")
      .run(V1, "u1", "2026-01-01T00:00:00.000Z");
    expect(addWatchedIds("u1", [V1, V2, "bad"])).toEqual([V2]);
    expect(listWatchedIds("u1")).toEqual([V1, V2]);
    const row = getDb()
      .prepare("SELECT watched_at FROM watched_videos WHERE video_id = ?")
      .get(V1) as { watched_at: string };
    expect(row.watched_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("parses ids from current and older shapes, ignoring timestamps", () => {
    expect(parseWatchedIds({ videoIds: [V1, V1, "nope"] })).toEqual([V1]);
    expect(parseWatchedIds([V1, { videoId: V2, watchedAt: "x" }])).toEqual([V1, V2]);
    expect(parseWatchedIds({ watched: [{ videoId: V3 }] })).toEqual([V3]);
    expect(parseWatchedIds({ nope: [] })).toBeNull();
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
    addWatchedIds("u1", [V1]);
    saveSubRelaySyncSettings("u1", { url: "http://subrelay:5173", apiKey: "srk_admin" });
  });

  it("merges both ways and sends the key only to SubRelay", async () => {
    const calls = stubSubRelay();
    const result = await runSubRelaySync("u1");

    expect(result.status).toBe("success");
    expect(result.subscriptions).toMatchObject({ pulled: 1, addedHere: 1, sent: 2, addedThere: 1, createdLists: ["Science"] });
    // Only what SubRelay lacks is sent (V1; it already has V2).
    expect(result.watched).toEqual({ pulled: 1, addedHere: 1, sent: 1, addedThere: 1 });
    expect(memberships(await readLists("u1"))).toEqual({ Default: [ALPHA], Science: [BRAVO] });
    expect(listWatchedIds("u1")).toEqual([V1, V2]);

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

/** A fake SubRelay watched API with fault injection. */
function stubWatchedApi(options: {
  remote?: string[];
  failGets?: number[];
  failPostsFrom?: number; // 1-based POST number from which every POST fails with 503
  postStatus?: number;
} = {}) {
  const remote = new Set(options.remote ?? []);
  const failGets = [...(options.failGets ?? [])];
  const posts: string[][] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname !== "/api/sync/watched") return json(404, {});
    if (method === "GET") {
      const fail = failGets.shift();
      if (fail === 0) throw new TypeError("fetch failed");
      if (fail) return json(fail, { error: "down" });
      return json(200, { count: remote.size, videoIds: [...remote] });
    }
    const body = JSON.parse(String(init.body));
    posts.push(body.videoIds);
    if (options.postStatus) return json(options.postStatus, { error: "nope" });
    if (options.failPostsFrom && posts.length >= options.failPostsFrom) return json(503, { error: "down" });
    let added = 0;
    for (const id of body.videoIds) {
      if (!remote.has(id)) {
        remote.add(id);
        added += 1;
      }
    }
    return json(200, { added });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { remote, posts, fetchMock };
}

function manyIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `v${String(i).padStart(10, "0")}`);
}

describe("runFeedWatchedSync", () => {
  beforeEach(() => {
    saveSubRelaySyncSettings("u1", { url: "http://subrelay:5173", apiKey: "srk_admin" });
  });

  it("syncs both ways and returns the ids newly watched here", async () => {
    addWatchedIds("u1", [V1]);
    const api = stubWatchedApi({ remote: [V2, V3] });

    const result = await runFeedWatchedSync("u1");

    expect(result.status).toBe("success");
    expect(result.newVideoIds.sort()).toEqual([V2, V3]);
    expect(listWatchedIds("u1")).toEqual([V1, V2, V3]);
    expect(api.posts).toEqual([[V1]]);
    expect([...api.remote].sort()).toEqual([V1, V2, V3]);
    expect(getSubRelaySyncSettings("u1")).toMatchObject({ lastWatchedStatus: "success" });
  });

  it("is throttled between feed refreshes unless forced", async () => {
    const api = stubWatchedApi({ remote: [V2] });
    await runFeedWatchedSync("u1");
    const calls = api.fetchMock.mock.calls.length;

    expect(await runFeedWatchedSync("u1")).toEqual({ status: "skipped", newVideoIds: [] });
    expect(api.fetchMock.mock.calls.length).toBe(calls);

    expect((await runFeedWatchedSync("u1", { force: true })).status).toBe("success");
    expect(FEED_WATCHED_SYNC_MIN_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("does nothing when watched sync is off or SubRelay isn't set up", async () => {
    const api = stubWatchedApi();
    saveSubRelaySyncSettings("u1", { url: "http://subrelay:5173", syncWatched: false });
    expect((await runFeedWatchedSync("u1")).status).toBe("disabled");
    saveSubRelaySyncSettings("u1", { url: "", syncWatched: true });
    expect((await runFeedWatchedSync("u1")).status).toBe("disabled");
    expect(api.fetchMock).not.toHaveBeenCalled();
  });

  it("retries transient failures (network error, 503) and succeeds", async () => {
    const api = stubWatchedApi({ remote: [V2], failGets: [0, 503] });
    const result = await runFeedWatchedSync("u1");
    expect(result.status).toBe("success");
    expect(result.newVideoIds).toEqual([V2]);
    expect(api.fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === "GET")).toHaveLength(3);
  });

  it("never throws: a persistent outage is recorded and retried next refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const result = await runFeedWatchedSync("u1");
    expect(result).toMatchObject({ status: "error", newVideoIds: [] });
    expect(getSubRelaySyncSettings("u1")).toMatchObject({ lastWatchedStatus: "error" });
    expect(getSubRelaySyncSettings("u1").lastWatchedMessage).toMatch(/retry/);
  });

  it("sends large sets in chunks and resumes after a partial failure", async () => {
    addWatchedIds("u1", manyIds(2500));
    const failing = stubWatchedApi({ failPostsFrom: 2 });

    const first = await runFeedWatchedSync("u1", { force: true });
    expect(first.status).toBe("error");
    expect(failing.remote.size).toBe(1000); // the first chunk landed
    expect(failing.posts.every((chunk) => chunk.length <= 1000)).toBe(true);

    const healthy = stubWatchedApi({ remote: [...failing.remote] });
    const second = await runFeedWatchedSync("u1", { force: true });
    expect(second.status).toBe("success");
    expect(healthy.posts.map((chunk) => chunk.length)).toEqual([1000, 500]);
    expect(healthy.remote.size).toBe(2500);
  });

  it("still pulls with a read-only key", async () => {
    addWatchedIds("u1", [V1]);
    stubWatchedApi({ remote: [V2], postStatus: 403 });
    const result = await runFeedWatchedSync("u1");
    expect(result.status).toBe("partial");
    expect(result.newVideoIds).toEqual([V2]);
    expect(getSubRelaySyncSettings("u1").lastWatchedMessage).toMatch(/read-only/);
  });
});

