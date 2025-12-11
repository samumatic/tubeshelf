import { NextResponse } from "next/server";
import { fetchChannelFeed } from "@/lib/rss";
import { readSubscriptions } from "@/lib/subscriptionStore";

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
    const subs = await readSubscriptions();
    channelIds = subs.map((s) => s.channelId);
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

