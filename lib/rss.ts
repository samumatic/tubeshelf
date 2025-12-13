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
    console.error("[RSS] Failed to fetch channel feed", {
      channelId,
      feedUrl,
      status: res.status,
      statusText: res.statusText,
    });
    throw new Error(
      `Failed to fetch feed for channel ${channelId}: ${res.status} ${res.statusText}`
    );
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
  if (userIndex !== -1 && parts[userIndex + 1])
    return `@${parts[userIndex + 1]}`;
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

async function resolveHandleToChannelId(
  handle: string
): Promise<string | null> {
  const cleanHandle = handle.startsWith("@") ? handle : `@${handle}`;
  const pageUrl = `https://www.youtube.com/${cleanHandle}`;

  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.8",
    cookie: "CONSENT=YES+1",
  };

  try {
    const res = await fetch(`${pageUrl}?hl=en&gl=US`, {
      cache: "no-store",
      headers,
    });
    if (!res.ok) {
      console.warn("[RSS] Handle resolution: Page fetch failed", {
        handle: cleanHandle,
        pageUrl,
        status: res.status,
      });
      return null;
    }
    const html = await res.text();

    // Look for the canonical URL first, which directly contains the channel handle
    // This is the most reliable way to get the correct channel ID
    const canonicalMatch = html.match(
      /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/([^"]+)"/
    );
    if (canonicalMatch) {
      const canonicalPath = canonicalMatch[1];
      // If it redirects to a channel ID, extract it
      if (canonicalPath.startsWith("channel/")) {
        const channelId = canonicalPath.replace("channel/", "");
        if (/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
          return channelId;
        }
      }
    }

    // Fallback: Look for ytInitialData with the channel's own metadata
    // This appears early in the page and contains the page's own channel info
    const initialDataMatch = html.match(/var ytInitialData = ({.*?});/);
    if (initialDataMatch) {
      try {
        const data = JSON.parse(initialDataMatch[1]);
        // Navigate through the initial data structure to find the channel ID
        // This is more reliable than regex on the whole page
        const channelId =
          data?.metadata?.channelMetadataRenderer?.externalId ||
          data?.metadata?.playlistMetadataRenderer?.externalId ||
          data?.microformat?.microformatDataRenderer?.externalId;
        if (channelId && /^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
          return channelId;
        }
      } catch (e) {
        // JSON parse failed, continue with regex fallback
      }
    }

    // Fallback: Search for channelId in the initial data, preferring the first occurrence
    // which is typically the page's own channel
    const regexes = [
      /"externalId":"(UC[A-Za-z0-9_-]{22})"/,
      /"channelId":"(UC[A-Za-z0-9_-]{22})"/,
      /"browseId":"(UC[A-Za-z0-9_-]{22})"/,
    ];

    for (const r of regexes) {
      const m = html.match(r);
      if (m?.[1]) {
        const channelId = m[1].replace(/["\s]/g, "");
        if (/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
          return channelId;
        }
      }
    }

    return null;
  } catch (err) {
    console.error("[RSS] Handle resolution error", {
      handle: cleanHandle,
      pageUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
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
