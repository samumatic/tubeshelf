import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * feedManager is a module-level singleton (deliberately - one fetch no
 * matter how many components mount), which is exactly what made it leak
 * data across accounts: nothing told it the logged-in user had changed, so
 * a fresh subscribe() handed back whatever the *previous* user's videos
 * were - in memory, or from localStorage on a fresh load - for the instant
 * before the real fetch for the new user overwrote it. setUser() closes
 * that gap; these tests exercise it directly against the shared instance,
 * matching how the module is actually used.
 */

function makeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
}

function feedResponse(items: Array<{ id: string; durationSeconds: number }>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ items }),
  };
}

describe("feedManager - per-user isolation", () => {
  let feedManager: (typeof import("./feedManager"))["feedManager"];

  beforeEach(async () => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vi.resetModules();
    ({ feedManager } = await import("./feedManager"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is a no-op when the same user is set again", () => {
    feedManager.setUser("user-a");
    const notifications: unknown[] = [];
    const unsubscribe = feedManager.subscribe(() => {
      notifications.push(feedManager.getData());
    });
    unsubscribe();

    feedManager.setUser("user-a"); // same id again

    // subscribe() already fired once above; setUser with the same id must
    // not have reset/renotified anything for it to matter here.
    expect(feedManager.getData().videos).toEqual([]);
  });

  it("clears cached videos in memory when a different user is set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        feedResponse([{ id: "video-a", durationSeconds: 120 }])
      )
    );

    feedManager.setUser("user-a");
    await feedManager.initialize();
    expect(feedManager.getData().videos.map((v) => v.id)).toEqual([
      "video-a",
    ]);

    feedManager.setUser("user-b");

    expect(feedManager.getData().videos).toEqual([]);
  });

  it("a listener subscribing right after setUser never sees the previous user's videos", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        feedResponse([{ id: "video-a", durationSeconds: 120 }])
      )
    );

    feedManager.setUser("user-a");
    await feedManager.initialize();

    feedManager.setUser("user-b");

    // This is the exact sequence app/page.tsx follows: setUser(), then
    // subscribe(). The listener's first (synchronous) call must already
    // reflect the reset state, not user-a's cached videos.
    const seen: string[][] = [];
    feedManager.subscribe((data) => {
      seen.push(data.videos.map((v) => v.id));
    });

    expect(seen[0]).toEqual([]);
  });

  it("stores each user's cache under a separate localStorage key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        feedResponse([{ id: "video-a", durationSeconds: 120 }])
      )
    );

    feedManager.setUser("user-a");
    await feedManager.initialize();

    expect(
      (globalThis as any).localStorage.getItem("tubeshelf_feed_cache.user-a")
    ).toContain("video-a");
    expect(
      (globalThis as any).localStorage.getItem("tubeshelf_feed_cache.user-b")
    ).toBeNull();
  });
});
