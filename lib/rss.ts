import { XMLParser } from "fast-xml-parser";

export interface FeedVideo {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  updatedAt?: string;
  url: string;
  thumbnail?: string;
  duration?: string;
  isShort?: boolean;
}

export interface ChannelMeta {
  channelId: string;
  title: string;
  thumbnail?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
});

function parseEntry(entry: any): FeedVideo | null {
  if (!entry) return null;
  const videoId = entry["yt:videoId"] || entry["videoId"];
  const link = Array.isArray(entry.link)
    ? entry.link.find((l: any) => l.rel === "alternate")?.href
    : entry.link?.href || entry.link;
  const mediaGroup = entry["media:group"] || entry.mediaGroup || {};
  const thumb =
    mediaGroup["media:thumbnail"]?.url ||
    mediaGroup["media:content"]?.url ||
    entry["media:thumbnail"]?.url ||
    (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : undefined);

  const published = entry.published || entry["published"];
  const updated = entry.updated || entry["updated"];

  return {
    id: videoId || entry.id,
    title: entry.title || "",
    channelId: entry["yt:channelId"] || entry["channelId"] || "",
    channelTitle: entry.author?.name || entry["author"]?.["name"] || "",
    publishedAt: published || new Date().toISOString(),
    updatedAt: updated,
    url: link || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : ""),
    thumbnail: thumb,
    duration: mediaGroup["media:content"]?.duration
      ? `${mediaGroup["media:content"].duration}s`
      : undefined,
    isShort: typeof link === "string" ? link.includes("/shorts/") : false,
  };
}

export async function fetchChannelFeed(channelId: string) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(
    channelId
  )}`;
  const res = await fetch(feedUrl, { next: { revalidate: 300 } });
  if (!res.ok) {
    throw new Error(`Failed to fetch feed for channel ${channelId}`);
  }
  const xml = await res.text();
  const parsed = parser.parse(xml);
  const feed = parsed?.feed;
  const entries = feed?.entry
    ? Array.isArray(feed.entry)
      ? feed.entry
      : [feed.entry]
    : [];

  const videos = entries
    .map((entry: any) => parseEntry(entry))
    .filter(Boolean) as FeedVideo[];

  const channelTitle = feed?.title || "";
  const channelThumbnail =
    entries[0]?.["media:group"]?.["media:thumbnail"]?.url ||
    entries[0]?.["media:thumbnail"]?.url ||
    (videos[0]?.thumbnail ? videos[0].thumbnail : undefined);

  const meta: ChannelMeta = {
    channelId,
    title: channelTitle,
    thumbnail: channelThumbnail,
  };

  return { videos, meta };
}

function getHandleFromPath(parts: string[]): string | null {
  const atHandle = parts.find((p) => p.startsWith("@"));
  if (atHandle) return atHandle;
  const cIndex = parts.indexOf("c");
  if (cIndex !== -1 && parts[cIndex + 1]) return `@${parts[cIndex + 1]}`;
  const userIndex = parts.indexOf("user");
  if (userIndex !== -1 && parts[userIndex + 1]) return `@${parts[userIndex + 1]}`;
  return null;
}

export function extractChannelId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Direct channel ID
  if (/^UC[A-Za-z0-9_-]{21}[A-Za-z0-9_-]{1}$/.test(trimmed)) {
    return trimmed;
  }

  // Handle only (e.g., @somechannel)
  if (trimmed.startsWith("@")) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.searchParams.get("channel_id")) {
      return url.searchParams.get("channel_id");
    }
    const pathParts = url.pathname.split("/").filter(Boolean);
    const channelIndex = pathParts.indexOf("channel");
    if (channelIndex !== -1 && pathParts[channelIndex + 1]) {
      return pathParts[channelIndex + 1];
    }
    const handle = getHandleFromPath(pathParts);
    if (handle) {
      return null; // will resolve via handle lookup
    }
  } catch {
    // Not a URL; fall through
  }

  return null;
}

async function resolveHandleToChannelId(handle: string): Promise<string | null> {
  const cleanHandle = handle.startsWith("@") ? handle : `@${handle}`;
  const pageUrls = [
    `https://www.youtube.com/${cleanHandle}`,
    `https://www.youtube.com/${cleanHandle}/about`,
    `https://www.youtube.com/${cleanHandle}/featured`,
  ];

  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.8",
    cookie: "CONSENT=YES+1",
  };

  const regexes = [
    /"channelId":"(UC[A-Za-z0-9_-]{22})"/,
    /"browseId":"(UC[A-Za-z0-9_-]{22})"/,
    /"externalId":"(UC[A-Za-z0-9_-]{22})"/,
    /"channelId":"(UC[A-Za-z0-9_\-]{22})"/,
    /channelId["\s:]+(["\s]?)(UC[A-Za-z0-9_-]{22})/,
  ];

  let lastError: any = null;
  for (const baseUrl of pageUrls) {
    const pageUrl = `${baseUrl}?hl=en&gl=US`;
    try {
      const res = await fetch(pageUrl, {
        cache: "no-store",
        headers,
      });
      if (!res.ok) continue;
      const html = await res.text();
      for (const r of regexes) {
        const m = html.match(r);
        if (m?.[1]) {
          const channelId = m[1].replace(/["\s]/g, "");
          if (/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
            return channelId;
          }
        }
      }
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  if (lastError) {
    console.error("Handle resolution failed", { handle: cleanHandle, error: lastError });
  }
  return null;
}

export async function resolveChannelId(input: string): Promise<string | null> {
  const direct = extractChannelId(input);
  if (direct) return direct;

  const trimmed = input.trim();
  if (trimmed.startsWith("@")) {
    return resolveHandleToChannelId(trimmed);
  }

  try {
    const url = new URL(trimmed);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const handle = getHandleFromPath(pathParts);
    if (handle) {
      return resolveHandleToChannelId(handle);
    }
  } catch {
    // not a url
  }

  return null;
}

