import { NextResponse } from "next/server";
import { fetchChannelFeed } from "@/lib/rss";
import { readLists } from "@/lib/subscriptionListStore";
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
  // If a fetch is in progress, coalesce this request and resolve when ready
  if (isFetching) {
    const result = await new Promise<any>((resolve) => {
      pendingResolvers.push(resolve);
    });
    return NextResponse.json(result);
  }

  isFetching = true;
  cacheTimestamp = Date.now();

  const url = new URL(req.url);
  const idsParam = url.searchParams.get("ids");
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

  const result = { items };
  cachedResult = result;
  isFetching = false;

  // Resolve any coalesced pending requests
  pendingResolvers.splice(0).forEach((resolve) => resolve(result));

  return NextResponse.json(result);
}
