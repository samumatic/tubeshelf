import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decideFeedMode,
  INITIAL_WAIT_MAX_MS,
  waitWithinBudget,
  type FeedPolicyInput,
} from "./feedPolicy";

const base: FeedPolicyInput = {
  cacheOnly: false,
  forceRefresh: false,
  usableCachedCount: 0,
  staleCount: 0,
  requestTimeoutSeconds: 60,
};

describe("decideFeedMode", () => {
  it("serves cached videos immediately when channels have never been fetched", () => {
    // A newly added subscription is stale (never fetched); it must not hold
    // up the videos that are already cached for the other channels.
    const decision = decideFeedMode({
      ...base,
      usableCachedCount: 120,
      staleCount: 3,
    });
    expect(decision).toEqual({ mode: "cache-first", refresh: true, waitMs: 0 });
  });

  it("allows a short wait when there are no cached videos at all", () => {
    const decision = decideFeedMode({ ...base, staleCount: 5 });
    expect(decision.mode).toBe("blocking");
    expect(decision.refresh).toBe(true);
    expect(decision.waitMs).toBe(INITIAL_WAIT_MAX_MS);
    expect(INITIAL_WAIT_MAX_MS).toBeLessThanOrEqual(5000);
  });

  it("caps the initial wait at the configured request timeout if lower", () => {
    const decision = decideFeedMode({
      ...base,
      staleCount: 1,
      requestTimeoutSeconds: 2,
    });
    expect(decision.waitMs).toBe(2000);
  });

  it("never waits longer than the cap, whatever the request timeout", () => {
    const decision = decideFeedMode({
      ...base,
      staleCount: 1,
      requestTimeoutSeconds: 600,
    });
    expect(decision.waitMs).toBe(INITIAL_WAIT_MAX_MS);
  });

  it("does not block a forced refresh when cached videos exist", () => {
    const decision = decideFeedMode({
      ...base,
      forceRefresh: true,
      usableCachedCount: 40,
      staleCount: 10,
    });
    expect(decision).toEqual({ mode: "cache-first", refresh: true, waitMs: 0 });
  });

  it("does not wait when there is nothing to refresh", () => {
    expect(decideFeedMode(base)).toEqual({
      mode: "cache-first",
      refresh: false,
      waitMs: 0,
    });
  });

  it("never refreshes or waits for a cache-only poll", () => {
    expect(
      decideFeedMode({ ...base, cacheOnly: true, staleCount: 4 })
    ).toEqual({ mode: "cache-only", refresh: false, waitMs: 0 });
  });
});

describe("waitWithinBudget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const hanging = () => new Promise<void>(() => undefined);

  it("does not wait on a hanging channel fetch when cached videos exist", async () => {
    vi.useFakeTimers();
    const decision = decideFeedMode({
      ...base,
      usableCachedCount: 10,
      staleCount: 1,
    });

    let settled = false;
    const wait = waitWithinBudget(hanging(), decision.waitMs).then((done) => {
      settled = true;
      return done;
    });

    // No timers advanced: the response path must not depend on any of them.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
    await expect(wait).resolves.toBe(false);
  });

  it("gives up on a hanging fetch after the initial wait cap", async () => {
    vi.useFakeTimers();
    const decision = decideFeedMode({ ...base, staleCount: 1 });

    let settled = false;
    const wait = waitWithinBudget(hanging(), decision.waitMs).then((done) => {
      settled = true;
      return done;
    });

    await vi.advanceTimersByTimeAsync(INITIAL_WAIT_MAX_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toBe(false);
  });

  it("returns as soon as the refresh finishes", async () => {
    await expect(waitWithinBudget(Promise.resolve(), 5000)).resolves.toBe(true);
  });

  it("treats a failed refresh as finished instead of rejecting", async () => {
    await expect(
      waitWithinBudget(Promise.reject(new Error("boom")), 5000)
    ).resolves.toBe(true);
  });
});

describe("GET /api/feed with a hanging channel fetch", () => {
  const CHANNEL_A = "UC" + "a".repeat(22);
  const CHANNEL_B = "UC" + "b".repeat(22);

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock("@/lib/apiAuth");
    vi.doUnmock("@/lib/videoFetcher");
    vi.doUnmock("@/lib/subscriptionListStore");
    vi.doUnmock("@/lib/videoCacheStore");
    vi.doUnmock("@/lib/settingsStore");
    vi.doUnmock("@/lib/userStateStore");
    vi.doUnmock("@/lib/durationBackfill");
  });

  async function loadRoute(cached: Array<Record<string, unknown>>) {
    vi.resetModules();
    const { defaultSettings } = await import("./settingsSchema");
    const fetchChannelFeed = vi.fn(() => new Promise(() => undefined));
    const pruneVideos = vi.fn(() => 0);

    vi.doMock("@/lib/apiAuth", () => ({
      requireUser: async () => ({ id: "u1", email: "u1@example.com" }),
    }));
    vi.doMock("@/lib/videoFetcher", () => ({ fetchChannelFeed }));
    vi.doMock("@/lib/subscriptionListStore", () => ({
      readLists: async () => ({
        lists: [
          {
            subscriptions: [
              { channelId: CHANNEL_A, thumbnail: "a.jpg" },
              // Never fetched: previously this alone made the request block.
              { channelId: CHANNEL_B, thumbnail: "b.jpg" },
            ],
          },
        ],
      }),
      updateSubscriptionMetadata: async () => undefined,
    }));
    vi.doMock("@/lib/videoCacheStore", () => ({
      effectiveRetentionDays: () => 0,
      getCachedVideos: () => cached.map((v) => ({ ...v })),
      getChannelFetchStates: () => new Map(),
      markChannelFetched: () => undefined,
      pruneVideos,
      resetDurationAttempts: () => 0,
      upsertVideos: () => 0,
    }));
    vi.doMock("@/lib/settingsStore", () => ({
      readSettings: async () => ({ ...defaultSettings }),
    }));
    vi.doMock("@/lib/userStateStore", () => ({
      readUserState: async () => ({ videoRetentionDays: 0 }),
    }));
    vi.doMock("@/lib/durationBackfill", () => ({
      backfillDurations: async () => undefined,
    }));

    const route = await import("@/app/api/feed/route");
    return { GET: route.GET, fetchChannelFeed, pruneVideos };
  }

  const video = {
    id: "vid1",
    channelId: CHANNEL_A,
    channelTitle: "A",
    title: "Cached",
    publishedAt: "2026-10-01T00:00:00.000Z",
    firstSeenAt: 1,
  };

  for (const query of ["", "?refresh=true"]) {
    it(`returns cached videos without waiting (${query || "no params"})`, async () => {
      const { GET, fetchChannelFeed, pruneVideos } = await loadRoute([video]);

      const started = Date.now();
      const res = await GET(new Request(`http://localhost/api/feed${query}`));
      const elapsed = Date.now() - started;
      const body = await res.json();

      expect(elapsed).toBeLessThan(1000);
      expect(body.items.map((v: { id: string }) => v.id)).toEqual(["vid1"]);
      expect(body.sync).toEqual({ stale: 2, inFlight: 2 });
      // The refresh was started, just not awaited.
      expect(fetchChannelFeed).toHaveBeenCalledTimes(2);
      // Pruning is deferred past the response.
      expect(pruneVideos).not.toHaveBeenCalled();
      await new Promise((resolve) => setImmediate(resolve));
      expect(pruneVideos).toHaveBeenCalledTimes(1);
    });
  }

  it("waits at most the initial cap when nothing is cached", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { GET } = await loadRoute([]);

    let settled = false;
    const pending = GET(new Request("http://localhost/api/feed")).then((res) => {
      settled = true;
      return res;
    });

    await vi.advanceTimersByTimeAsync(INITIAL_WAIT_MAX_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const body = await (await pending).json();
    expect(body.items).toEqual([]);
    expect(body.sync.inFlight).toBe(2);
  });
});
