/**
 * Singleton Feed Manager
 * Ensures only one data fetch happens regardless of component instances
 */

import { Video } from "./apiClient";
import { videoListsMatch } from "./videoUtils";

type FeedData = {
  videos: Video[];
  loading: boolean;
  fetching: boolean; // Background refresh in progress
  error: string | null;
  currentChannelTitle?: string | null;
};

type Listener = (data: FeedData) => void;

const CACHE_KEY = "tubeshelf_feed_cache";

/** How long to wait between checks for newly resolved video lengths. */
const DURATION_POLL_INTERVAL_MS = 5000;
/** Consecutive fruitless polls before giving up on the remaining videos. */
const DURATION_POLL_MAX_STAGNANT = 2;
/**
 * How long to wait before re-checking a cache-first load against the server.
 * A non-forced /api/feed request can trigger a per-channel refresh on the
 * server that runs in the background and isn't reflected in that request's
 * own (already-sent) response - see app/api/feed/route.ts. This gives that
 * refresh time to land before checking once for it.
 */
const STALE_CACHE_RECHECK_DELAY_MS = 6000;

export class AuthExpiredError extends Error {
  constructor(message = "Session expired. Please sign in again.") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

class FeedManager {
  private static instance: FeedManager;
  private data: FeedData = {
    videos: [],
    loading: false,
    fetching: false,
    error: null,
    currentChannelTitle: null,
  };
  private listeners: Set<Listener> = new Set();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private hasCachedData = false;
  private durationPollTimer: ReturnType<typeof setTimeout> | null = null;
  private durationPollsWithoutProgress = 0;
  private staleCacheRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  // This is a module-level singleton, so it outlives any one user's session -
  // it has to know whose data it's holding, or switching accounts in the
  // same tab (or the same browser reusing localStorage on reload) flashes
  // the previous user's cached videos before the real fetch overwrites them.
  private currentUserId: string | null = null;

  private constructor() {}

  private cacheKey(): string | null {
    return this.currentUserId ? `${CACHE_KEY}.${this.currentUserId}` : null;
  }

  private loadCache(): FeedData | null {
    const key = this.cacheKey();
    if (!key) return null;
    try {
      const cached = localStorage.getItem(key);
      if (cached) {
        const data = JSON.parse(cached);
        // Return cached data with loading: false so it displays immediately
        return { ...data, loading: false, error: null };
      }
    } catch (e) {
      console.error("Failed to load cache:", e);
    }
    return null;
  }

  private saveCache() {
    const key = this.cacheKey();
    if (!key) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          videos: this.data.videos,
        })
      );
    } catch (e) {
      console.error("Failed to save cache:", e);
    }
  }

  /**
   * Tell the manager which user it's serving. Call this before subscribe()
   * whenever the logged-in user is (or might be) different from last time -
   * a no-op if it's the same user as already set, otherwise drops all
   * in-memory and cached feed state so the next subscribe() can't hand back
   * a stale previous user's videos even for an instant.
   */
  setUser(userId: string | null) {
    if (userId === this.currentUserId) return;

    this.currentUserId = userId;
    this.cancelDurationPoll();
    this.cancelStaleCacheRecheck();
    this.durationPollsWithoutProgress = 0;
    this.initialized = false;
    this.initPromise = null;
    this.hasCachedData = false;
    this.data = {
      videos: [],
      loading: false,
      fetching: false,
      error: null,
      currentChannelTitle: null,
    };
    this.notify();
  }

  static getInstance(): FeedManager {
    if (!FeedManager.instance) {
      FeedManager.instance = new FeedManager();
    }
    return FeedManager.instance;
  }

  subscribe(listener: Listener, skipAutoInit = false): () => void {
    this.listeners.add(listener);

    // Load cache on first subscription if not already loaded
    if (this.listeners.size === 1 && !this.initialized) {
      const cached = this.loadCache();
      if (cached && cached.videos && cached.videos.length > 0) {
        this.data = cached;
        this.hasCachedData = true;
      }
    }

    // Immediately notify with current data (cached or empty)
    listener(this.data);

    // Auto-initialize on first subscription to fetch fresh data
    // Skip if skipAutoInit is true (e.g., during welcome wizard)
    if (!this.initialized && !this.initPromise && !skipAutoInit) {
      this.initialize().catch(() => undefined);
    }

    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    this.listeners.forEach((listener) => listener(this.data));
  }

  private updateData(updates: Partial<FeedData>) {
    this.data = { ...this.data, ...updates };
    this.notify();
  }

  private mapItems(items: any[]): Video[] {
    return items.map((raw: any) => ({
      id: raw.id || raw.videoId,
      title: raw.title || "Untitled",
      channel:
        raw.channelTitle || raw.uploaderName || raw.channel || "Unknown Channel",
      channelId: raw.channelId || raw.uploaderId || "",
      thumbnail:
        raw.thumbnail ||
        raw.thumbnailUrl ||
        `https://i.ytimg.com/vi/${raw.id || raw.videoId}/hqdefault.jpg`,
      duration: raw.duration,
      durationSeconds: raw.durationSeconds,
      views: raw.viewCount ?? raw.views,
      uploadedAt:
        raw.publishedAt ||
        raw.uploadDate ||
        raw.uploaded ||
        new Date().toISOString(),
      url:
        raw.url || `https://www.youtube.com/watch?v=${raw.id || raw.videoId}`,
      isMemberOnly: raw.isMemberOnly || raw.membersOnly || false,
    }));
  }

  private countKnownDurations(videos: Video[]): number {
    return videos.filter((video) => typeof video.durationSeconds === "number")
      .length;
  }

  private cancelDurationPoll() {
    if (this.durationPollTimer) {
      clearTimeout(this.durationPollTimer);
      this.durationPollTimer = null;
    }
  }

  private cancelStaleCacheRecheck() {
    if (this.staleCacheRecheckTimer) {
      clearTimeout(this.staleCacheRecheckTimer);
      this.staleCacheRecheckTimer = null;
    }
  }

  /**
   * A cache-first load (e.g. right after the tab was unloaded and reloaded,
   * long enough for a channel to go stale) can hand back data a background
   * refresh is about to replace, with no way for the client to know when
   * that lands. This does one follow-up fetch shortly after such a load to
   * pick up the result, instead of leaving the user stuck looking at stale
   * data until they refresh by hand.
   */
  private scheduleStaleCacheRecheck() {
    this.cancelStaleCacheRecheck();
    this.staleCacheRecheckTimer = setTimeout(() => {
      this.staleCacheRecheckTimer = null;
      this.recheckAfterCacheFirstLoad().catch(() => undefined);
    }, STALE_CACHE_RECHECK_DELAY_MS);
  }

  private async recheckAfterCacheFirstLoad() {
    const response = await fetch("/api/feed?refresh=false");
    if (!response.ok) return;

    const json = await response.json();
    const videos = this.mapItems(json.items || []);

    if (!videoListsMatch(this.data.videos, videos)) {
      this.updateData({ videos });
      this.saveCache();
    }
  }

  /**
   * Video lengths are resolved on the server a batch at a time, after the feed
   * response has already been sent. Poll while any are still missing so the
   * badges and the total fill in on their own instead of waiting for a reload.
   *
   * Polling stops as soon as every video has a length, or once the server
   * stops making progress — some videos never resolve, and those must not keep
   * the timer alive forever.
   */
  private scheduleDurationPoll() {
    if (this.durationPollTimer) return;

    const videos = this.data.videos;
    if (videos.length === 0) return;
    if (this.countKnownDurations(videos) === videos.length) return;
    if (this.durationPollsWithoutProgress >= DURATION_POLL_MAX_STAGNANT) return;

    this.durationPollTimer = setTimeout(() => {
      this.durationPollTimer = null;
      this.pollDurations().catch(() => undefined);
    }, DURATION_POLL_INTERVAL_MS);
  }

  private async pollDurations() {
    const known = this.countKnownDurations(this.data.videos);

    const response = await fetch("/api/feed?refresh=false");
    if (!response.ok) {
      // Treat a failed poll like a no-progress one: keep retrying (a single
      // transient error shouldn't permanently stop durations from filling
      // in), but still count toward the stagnation cutoff so a server that's
      // consistently erroring doesn't poll forever.
      this.durationPollsWithoutProgress++;
      this.scheduleDurationPoll();
      return;
    }

    const json = await response.json();
    const videos = this.mapItems(json.items || []);

    if (this.countKnownDurations(videos) > known) {
      this.durationPollsWithoutProgress = 0;
      this.updateData({ videos });
      this.saveCache();
    } else {
      this.durationPollsWithoutProgress++;
    }

    this.scheduleDurationPoll();
  }

  async initialize(forceRefresh = false) {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        // A fetch is about to supply fresher data than any pending poll would.
        this.cancelDurationPoll();
        this.cancelStaleCacheRecheck();

        // Show fetching state to indicate background refresh
        // Show loading only if we don't have cached data
        if (!this.hasCachedData) {
          this.updateData({ loading: true, fetching: true, error: null });
        } else {
          this.updateData({ fetching: true, error: null });
        }

        // Retry logic for dev server race condition
        const maxRetries = 3;
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            if (attempt > 0) {
              // Wait before retrying (exponential backoff)
              const delay = Math.min(1000 * Math.pow(2, attempt - 1), 3000);
              console.log(
                `[FeedManager] Retrying fetch (attempt ${
                  attempt + 1
                }/${maxRetries}) after ${delay}ms...`
              );
              await new Promise((resolve) => setTimeout(resolve, delay));
            }

            const response = await fetch(
              `/api/feed?refresh=${forceRefresh ? "true" : "false"}`
            );

            if (!response.ok) {
              if (response.status === 401) {
                throw new AuthExpiredError();
              }
              throw new Error(`HTTP error! status: ${response.status}`);
            }

            const json = await response.json();
            const videos = this.mapItems(json.items || []);

            // Only update if data actually changed (prevents visual flicker when cache matches fresh data)
            const dataChanged =
              this.data.videos.length !== videos.length ||
              !videoListsMatch(this.data.videos, videos);

            if (dataChanged || !this.hasCachedData) {
              this.updateData({
                videos,
                loading: false,
                fetching: false,
                currentChannelTitle: null,
              });
            } else {
              // Don't update arrays - keep showing cached data
              // Just update fetching/loading states
              this.updateData({
                loading: false,
                fetching: false,
                currentChannelTitle: null,
              });
            }

            this.initialized = true;
            this.saveCache();
            // Lengths are backfilled after this response was built, so watch
            // for the ones that are still missing.
            this.scheduleDurationPoll();
            // A non-forced request can have just triggered a background
            // per-channel refresh server-side without waiting for it - check
            // back for that once. A forced refresh already waited for it.
            if (!forceRefresh) {
              this.scheduleStaleCacheRecheck();
            }
            return;
          } catch (err) {
            if (err instanceof AuthExpiredError) {
              this.initialized = false;
              this.updateData({
                loading: false,
                fetching: false,
                currentChannelTitle: null,
                error: null,
              });
              throw err;
            }

            lastError = err instanceof Error ? err : new Error(String(err));
            console.error(
              `[FeedManager] Error (attempt ${attempt + 1}/${maxRetries}):`,
              err
            );

            // If this was the last attempt, update with error state
            if (attempt === maxRetries - 1) {
              this.updateData({
                error: lastError.message || "Failed to fetch feed",
                loading: false,
                fetching: false,
                currentChannelTitle: null,
              });
            }
            // Otherwise continue to next retry attempt
          }
        }
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  async refresh() {
    this.initialized = false;
    // A manual refresh also clears written-off lengths server-side, so give
    // polling a fresh budget to pick the retried ones up.
    this.durationPollsWithoutProgress = 0;
    // Don't clear hasCachedData - keep showing cached videos while refreshing
    // This prevents flicker during manual refresh
    // Manual refresh bypasses the server-side per-channel refresh interval.
    return this.initialize(true);
  }

  getData(): FeedData {
    return this.data;
  }
}

export const feedManager = FeedManager.getInstance();
