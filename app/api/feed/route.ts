import { NextResponse } from "next/server";
import { fetchChannelFeed } from "@/lib/rss";
import { readLists, writeLists } from "@/lib/subscriptionListStore";
import { initProgress, updateProgress, getProgress } from "@/lib/feedProgress";

const CONCURRENCY = 4;

// Track if a fetch is currently in progress to prevent duplicate requests
let isFetching = false;
let cachedResult: any = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 1000; // 1 second cache to prevent duplicate requests

// Queue for pending requests to coalesce while in-flight
let pendingResolvers: Array<(result: any) => void> = [];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const idsParam = url.searchParams.get("ids");
  const forceRefresh = url.searchParams.get("refresh") === "true";

  // Check cache only if not forced refresh
  if (
    !forceRefresh &&
    cachedResult &&
    Date.now() - cacheTimestamp < CACHE_DURATION
  ) {
    return NextResponse.json(cachedResult);
  }

  // If a fetch is in progress and not forced refresh, coalesce this request
  if (isFetching && !forceRefresh) {
    const result = await new Promise<any>((resolve) => {
      pendingResolvers.push(resolve);
    });
    return NextResponse.json(result);
  }

  isFetching = true;
  cacheTimestamp = Date.now();

  let channelIds: string[] = [];

  if (idsParam) {
    channelIds = idsParam
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  } else {
    // Get all unique channel IDs from all subscription lists
    const listsData = await readLists();
    const uniqueChannelIds = new Set<string>();
    listsData.lists.forEach((list) => {
      list.subscriptions.forEach((sub) => {
        uniqueChannelIds.add(sub.channelId);
      });
    });
    channelIds = Array.from(uniqueChannelIds);
  }

  if (channelIds.length === 0) {
    return NextResponse.json({ items: [] });
  }

  // Initialize progress tracking
  initProgress(channelIds.length);
  const { sessionId } = getProgress();

  const items: any[] = [];
  // Use a shared queue to avoid race conditions causing duplicate processing
  const queue = [...channelIds];

  const worker = async () => {
    // Loop until queue is empty; shift() ensures unique assignment
    while (queue.length > 0) {
      const current = queue.shift()!;
      try {
        const { videos, meta } = await fetchChannelFeed(current);
        videos.forEach((video) => {
          items.push({
            ...video,
            channelTitle: video.channelTitle || meta.title,
            thumbnail: video.thumbnail || meta.thumbnail,
            channelId: video.channelId || current,
            isShort: video.isShort,
          });
        });
        // Update progress with channel info
        updateProgress(current, meta.title, sessionId);
      } catch (err) {
        console.error("[Feed] Failed to load feed for channel", {
          channelId: current,
          error: err instanceof Error ? err.message : String(err),
        });
        // Still update progress even on error
        updateProgress(current, `[Error] ${current}`, sessionId);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  items.sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );

  // Return feed immediately without waiting for avatar enrichment
  const result = { items };
  cachedResult = result;
  isFetching = false;

  // Resolve any coalesced pending requests
  pendingResolvers.splice(0).forEach((resolve) => resolve(result));

  // Fetch avatars and update subscriptions in the background (non-blocking)
  fetchAvatarsAndUpdateAsync(channelIds).catch((err) =>
    console.warn("[Feed] Background avatar fetch failed", {
      error: String(err),
    })
  );

  return NextResponse.json(result);
}

// Background async function to fetch avatars and update subscriptions
async function fetchAvatarsAndUpdateAsync(channelIds: string[]) {
  const avatars = new Map<string, string>();

  // Fetch all avatars in parallel with a short timeout each
  await Promise.all(
    channelIds.map(async (channelId) => {
      try {
        const avatar = await fetchChannelAvatarDirect(channelId);
        if (avatar) {
          avatars.set(channelId, avatar);
        }
      } catch {
        // Silently fail on individual avatar fetches
      }
    })
  );

  // Update subscriptions with the fetched avatars
  if (avatars.size > 0) {
    try {
      const listsData = await readLists();
      let updated = false;
      listsData.lists.forEach((list) => {
        list.subscriptions.forEach((sub) => {
          const avatar = avatars.get(sub.channelId);
          if (avatar && sub.thumbnail !== avatar) {
            sub.thumbnail = avatar;
            updated = true;
          }
        });
      });
      if (updated) {
        console.log(
          `[Feed] Updated ${
            updated ? "subscriptions" : "no subscriptions"
          } with avatars`
        );
        await writeLists(listsData);
      }
    } catch (err) {
      console.warn("[Feed] Failed to update subscriptions with avatars", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
