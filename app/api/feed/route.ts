import { NextResponse } from "next/server";
import { fetchChannelFeed } from "@/lib/videoFetcher";
import { readLists, writeLists } from "@/lib/subscriptionListStore";
import { getCurrentUser } from "@/lib/currentUser";
import {
  CachedVideo,
  ChannelFetchState,
  countCachedVideos,
  effectiveRetentionDays,
  getCachedVideos,
  getChannelFetchStates,
  markChannelFetched,
  pruneVideos,
  resetDurationAttempts,
  upsertVideos,
} from "@/lib/videoCacheStore";
import { backfillDurations } from "@/lib/durationBackfill";
import { readSettings, type AppSettings } from "@/lib/settingsStore";
import { readUserState } from "@/lib/userStateStore";

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// One in-flight fetch per channel, shared across users and requests.
const inFlightChannels = new Map<string, Promise<void>>();
let lastPruneAt = 0;
// One duration backfill batch at a time, so concurrent page loads do not stack
// batches on top of each other.
let durationBackfillInFlight = false;

function compareFeedItems(a: CachedVideo, b: CachedVideo): number {
  const timeDiff =
    new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  if (timeDiff !== 0) return timeDiff;

  // Preserve the order in which this instance first saw tied videos.
  if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt - b.firstSeenAt;

  const channelDiff = String(a.channelId || "").localeCompare(
    String(b.channelId || "")
  );
  if (channelDiff !== 0) return channelDiff;

  return String(a.id || "").localeCompare(String(b.id || ""));
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timeout after ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Fetch one channel and persist whatever came back.
 * Never rejects: a failing channel must not lose the other channels' results.
 */
function refreshChannel(
  channelId: string,
  settings: AppSettings
): Promise<void> {
  const existing = inFlightChannels.get(channelId);
  if (existing) return existing;

  const run = (async () => {
    try {
      const result = await withTimeout(
        fetchChannelFeed(channelId),
        settings.feedChannelTimeoutSeconds * 1000,
        `Channel ${channelId} fetch`
      );

      const videos = result?.videos || [];
      const written = upsertVideos(channelId, videos);

      if (videos.length === 0 && !result?.meta?.title) {
        console.warn(
          `[Feed] Channel unavailable or returned no data: ${channelId}`
        );
        markChannelFetched(channelId, {
          videoCount: 0,
          error: "No videos and no channel metadata returned",
        });
        return;
      }

      markChannelFetched(channelId, { videoCount: written });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Feed] Failed to refresh channel ${channelId}: ${message}`);
      markChannelFetched(channelId, { videoCount: 0, error: message });
    } finally {
      inFlightChannels.delete(channelId);
    }
  })();

  inFlightChannels.set(channelId, run);
  return run;
}

async function refreshChannels(
  channelIds: string[],
  settings: AppSettings
): Promise<void> {
  if (channelIds.length === 0) return;

  const queue = [...channelIds];
  const worker = async () => {
    while (queue.length > 0) {
      const channelId = queue.shift()!;
      await refreshChannel(channelId, settings);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(settings.feedConcurrency, channelIds.length) },
      worker
    )
  );
}

/**
 * Resolve unknown video durations without holding up the response.
 *
 * Neither the RSS nor the standard fetcher reliably reports video length, so
 * lengths are filled in one video at a time and stored permanently. The batch
 * is bounded, so a large feed converges over several page loads rather than in
 * one burst of requests to YouTube.
 */
function scheduleDurationBackfill(
  channelIds: string[],
  settings: AppSettings
): void {
  if (durationBackfillInFlight) return;
  durationBackfillInFlight = true;

  backfillDurations(channelIds, settings.feedConcurrency)
    .catch((err) => console.warn("[Duration] Backfill failed:", err))
    .finally(() => {
      durationBackfillInFlight = false;
    });
}

function getStaleChannels(
  channelIds: string[],
  states: Map<string, ChannelFetchState>,
  settings: AppSettings
): string[] {
  const now = Date.now();
  const refreshMs = settings.feedRefreshMinutes * 60 * 1000;
  const errorRetryMs = settings.feedErrorRetryMinutes * 60 * 1000;

  return channelIds.filter((channelId) => {
    const state = states.get(channelId);
    if (!state?.lastFetchedAt) return true;

    const age = now - Date.parse(state.lastFetchedAt);
    if (!Number.isFinite(age)) return true;

    return age > (state.lastError ? errorRetryMs : refreshMs);
  });
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return await handleFeedRequest(req, user);
  } catch (error) {
    console.error("[Feed] Request handler error:", error);
    return NextResponse.json(
      { error: "Internal server error", items: [] },
      { status: 500 }
    );
  }
}

async function handleFeedRequest(
  req: Request,
  user: { id: string; email: string }
): Promise<NextResponse> {
  const url = new URL(req.url);
  const idsParam = url.searchParams.get("ids");
  const forceRefresh = url.searchParams.get("refresh") === "true";
  const requestId = Math.random().toString(36).substring(7);

  const [settings, userState] = await Promise.all([
    readSettings(),
    readUserState(user.id),
  ]);
  const retentionDays = effectiveRetentionDays(
    userState.videoRetentionDays,
    settings.videoRetentionDays
  );

  let channelIds: string[] = [];
  const subscriptionMetadata = new Map<string, any>();

  if (idsParam) {
    channelIds = idsParam
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  } else {
    const listsData = await readLists(user.id);
    listsData.lists.forEach((list) => {
      list.subscriptions.forEach((sub) => {
        if (!subscriptionMetadata.has(sub.channelId)) {
          subscriptionMetadata.set(sub.channelId, sub);
        }
      });
    });
    channelIds = Array.from(subscriptionMetadata.keys());
  }

  if (channelIds.length === 0) {
    return NextResponse.json({ items: [] });
  }

  const cachedCount = countCachedVideos(channelIds);
  const fetchStates = getChannelFetchStates(channelIds);
  const neverFetched = channelIds.filter(
    (id) => !fetchStates.get(id)?.lastFetchedAt
  );
  const staleChannels = forceRefresh
    ? channelIds
    : getStaleChannels(channelIds, fetchStates, settings);
  // Wait for the fetch when the client asked for it, when there is nothing to
  // show yet, or when a freshly added subscription has never been fetched.
  const blocking = forceRefresh || cachedCount === 0 || neverFetched.length > 0;

  console.log(
    `[Feed] Request ${requestId}: ${channelIds.length} channels, ` +
      `${cachedCount} cached videos, ${staleChannels.length} stale, ` +
      `retention=${retentionDays === 0 ? "forever" : `${retentionDays}d`}, ` +
      `mode=${blocking ? "blocking" : "cache-first"}`
  );

  if (staleChannels.length > 0) {
    const refresh = refreshChannels(staleChannels, settings);

    if (blocking) {
      try {
        // Partial results are already persisted per channel, so a slow refresh
        // degrades to "serve what we have" instead of returning nothing.
        await withTimeout(
          refresh,
          settings.feedRequestTimeoutSeconds * 1000,
          "Feed refresh"
        );
      } catch (err) {
        console.warn(
          `[Feed] Request ${requestId}: ${
            err instanceof Error ? err.message : String(err)
          }, serving cached videos while the refresh continues`
        );
      }
    } else {
      refresh.catch((err) =>
        console.warn("[Feed] Background refresh failed:", err)
      );
    }
  }

  if (forceRefresh) {
    // An explicit refresh is also a retry for videos written off earlier.
    const retried = resetDurationAttempts(channelIds);
    if (retried > 0) {
      console.log(`[Duration] Reset attempts for ${retried} videos`);
    }
  }

  scheduleDurationBackfill(channelIds, settings);

  const items = getCachedVideos(channelIds, retentionDays).sort(
    compareFeedItems
  );

  console.log(
    `[Feed] Request ${requestId} completed - returning ${items.length} items`
  );

  if (!idsParam && items.length > 0) {
    updateSubscriptionMetadataAsync(items, user.id).catch((err) =>
      console.warn("[Feed] Failed to update subscription metadata:", err)
    );
  }

  if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
    lastPruneAt = Date.now();
    try {
      // Deletes only what no subscriber of the channel still wants to keep.
      const pruned = pruneVideos(settings.videoRetentionDays);
      if (pruned > 0) {
        console.log(`[Feed] Pruned ${pruned} videos past their retention window`);
      }
    } catch (err) {
      console.warn("[Feed] Prune failed:", err);
    }
  }

  return NextResponse.json({ items });
}

/**
 * Keep `lastUploadedAt` in sync and backfill missing channel avatars.
 * Runs in the background; avatars are only fetched for subscriptions that
 * still lack one, so a normal refresh does not hit 30 channel pages twice.
 */
async function updateSubscriptionMetadataAsync(
  items: CachedVideo[],
  userId: string
) {
  const latestUpload = new Map<string, string>();
  for (const item of items) {
    const current = latestUpload.get(item.channelId);
    if (!current || item.publishedAt > current) {
      latestUpload.set(item.channelId, item.publishedAt);
    }
  }

  const listsData = await readLists(userId);
  const missingAvatars = new Set<string>();
  let updated = false;

  listsData.lists.forEach((list) => {
    list.subscriptions.forEach((sub) => {
      const uploadedAt = latestUpload.get(sub.channelId);
      if (uploadedAt && sub.lastUploadedAt !== uploadedAt) {
        sub.lastUploadedAt = uploadedAt;
        updated = true;
      }
      if (!sub.thumbnail) {
        missingAvatars.add(sub.channelId);
      }
    });
  });

  if (missingAvatars.size > 0) {
    const avatars = new Map<string, string>();
    await Promise.all(
      Array.from(missingAvatars).map(async (channelId) => {
        const avatar = await fetchChannelAvatarDirect(channelId);
        if (avatar) avatars.set(channelId, avatar);
      })
    );

    listsData.lists.forEach((list) => {
      list.subscriptions.forEach((sub) => {
        const avatar = avatars.get(sub.channelId);
        if (avatar && sub.thumbnail !== avatar) {
          sub.thumbnail = avatar;
          updated = true;
        }
      });
    });
  }

  if (updated) {
    await writeLists(listsData, userId);
  }
}

// Inline avatar fetch to avoid circular imports
async function fetchChannelAvatarDirect(
  channelId: string,
  timeoutMs = 1500
): Promise<string | undefined> {
  const pageUrl = `https://www.youtube.com/channel/${channelId}`;
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.8",
    cookie: "CONSENT=YES+1",
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(`${pageUrl}?hl=en&gl=US`, {
      cache: "no-store",
      headers,
      signal: controller.signal as any,
    });

    clearTimeout(timer);
    if (!res.ok) {
      return undefined;
    }

    const html = await res.text();

    // Prefer the Open Graph image (channel avatar)
    const ogImageMatch = html.match(/property="og:image"\s+content="([^"]+)"/);
    if (ogImageMatch?.[1]) {
      return ogImageMatch[1].replace(/\\u0026/g, "&");
    }

    // Fallback: look for avatar thumbnails in embedded JSON
    const avatarMatch = html.match(
      /"avatar"\s*:\s*\{"thumbnails"\s*:\s*\[\s*\{"url":"([^"]+)"/
    );
    if (avatarMatch?.[1]) {
      return avatarMatch[1].replace(/\\u0026/g, "&");
    }

    return undefined;
  } catch {
    return undefined;
  }
}
