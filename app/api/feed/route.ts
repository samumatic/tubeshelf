import { NextResponse } from "next/server";
import { fetchChannelFeed } from "@/lib/rss";
import { readLists } from "@/lib/subscriptionListStore";

const CONCURRENCY = 4;

export async function GET(req: Request) {
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

  const items: any[] = [];
  let index = 0;

  const worker = async () => {
    while (index < channelIds.length) {
      const current = channelIds[index];
      index += 1;
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
      } catch (err) {
        console.error(`Failed to load feed for ${current}:`, err);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  items.sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );

  return NextResponse.json({ items });
}
