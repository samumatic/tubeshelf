/**
 * RSS Feed Fetcher for YouTube channels
 *
 * Fast alternative using YouTube's RSS feeds via channel_id.
 * Limited to recent videos (typically ~15-20) but faster than standard method.
 * Does NOT provide duration data - RSS feeds don't include this.
 */

import { FeedVideo, ChannelMeta, FetchResult } from "./videoFetcher";

// YouTube RSS Feed URL patterns
export const getChannelRssUrl = (channelId: string): string => {
  // YouTube no longer serves the synthetic "UU"/"UULF" uploads-playlist IDs
  // via this endpoint (always 404s) - channel_id is the only form that still
  // works. This includes Shorts; RSS mode has no duration data to filter
  // them by length anyway.
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
};

const getUserRssUrl = (handle: string): string => {
  // Remove @ if present
  const cleanHandle = handle.startsWith("@") ? handle.slice(1) : handle;
  return `https://www.youtube.com/feeds/videos.xml?user=${cleanHandle}`;
};

interface RSSItem {
  title?: string;
  link?: string;
  "yt:videoid"?: string;
  "yt:channelid"?: string;
  "yt:uploadedtime"?: string;
  pubDate?: string;
  author?: string;
  "media:thumbnail"?: { $: { url?: string } };
  "media:description"?: string;
}

interface RSSFeed {
  feed?: {
    entry?: RSSItem[];
    "yt:channelid"?: string;
    title?: string;
    link?: Array<{ $?: { href?: string } }>;
    logo?: string;
  };
}

/**
 * Parse RSS XML response from YouTube
 */
function parseRSSXML(xmlText: string): RSSFeed {
  // Simple XML parser for YouTube RSS feeds
  // YouTube RSS is relatively simple and consistent
  const feed: RSSFeed = { feed: { entry: [] } };

  // Extract channel ID
  const channelIdMatch = xmlText.match(/<yt:channelId>([^<]+)<\/yt:channelId>/);
  if (channelIdMatch && feed.feed) {
    feed.feed["yt:channelid"] = channelIdMatch[1];
  }

  // Extract title
  const titleMatch = xmlText.match(/<title(?:\s[^>]*)?>([^<]+)<\/title>/);
  if (titleMatch && feed.feed) {
    feed.feed.title = titleMatch[1];
  }

  // Extract logo/thumbnail
  const logoMatch = xmlText.match(/<logo>([^<]+)<\/logo>/);
  if (logoMatch && feed.feed) {
    feed.feed.logo = logoMatch[1];
  }

  // Parse entries
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(xmlText)) !== null) {
    const entryXml = entryMatch[1];
    const entry: RSSItem = {};

    // Extract title
    const titleM = entryXml.match(/<title(?:\s[^>]*)?>([^<]+)<\/title>/);
    if (titleM) entry.title = titleM[1];

    // Extract video ID
    const videoIdM = entryXml.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (videoIdM) entry["yt:videoid"] = videoIdM[1];

    // Extract channel ID
    const chanIdM = entryXml.match(/<yt:channelId>([^<]+)<\/yt:channelId>/);
    if (chanIdM) entry["yt:channelid"] = chanIdM[1];

    // Extract publish date
    const pubDateM = entryXml.match(/<published>([^<]+)<\/published>/);
    if (pubDateM) entry["yt:uploadedtime"] = pubDateM[1];

    // Extract author
    const authorM = entryXml.match(/<author>\s*<name>([^<]+)<\/name>/);
    if (authorM) entry.author = authorM[1];

    // Extract thumbnail URL
    const thumbM = entryXml.match(/<media:thumbnail\s+url='([^']+)'/);
    if (thumbM) {
      entry["media:thumbnail"] = { $: { url: thumbM[1] } };
    }

    // Extract link
    const linkM = entryXml.match(/<link\s+rel='alternate'\s+href='([^']+)'/);
    if (linkM) entry.link = linkM[1];

    if (entry["yt:videoid"]) {
      feed.feed?.entry?.push(entry);
    }
  }

  return feed;
}

/**
 * Extract thumbnail from media URL
 */
function extractThumbnailUrl(videoId: string, mediaUrl?: string): string {
  if (mediaUrl) {
    // Try to normalize YouTube thumbnail URLs
    const hqdefaultMatch = mediaUrl.match(/\/vi\/([^/]+)\//);
    if (hqdefaultMatch) {
      return `https://i.ytimg.com/vi/${hqdefaultMatch[1]}/hqdefault.jpg`;
    }
    return mediaUrl;
  }
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/**
 * Fetch channel feed using RSS (pure RSS, fast mode)
 */
export async function fetchChannelFeedRss(
  channelId: string
): Promise<FetchResult> {
  try {
    const rssUrl = getChannelRssUrl(channelId);

    const response = await fetch(rssUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/xml, text/xml, application/atom+xml, */*",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      console.error(`[RSS] ❌ HTTP error ${response.status} for ${channelId}`);
      const errorText = await response.text();
      console.error(
        `[RSS] Error response body (first 500 chars):`,
        errorText.substring(0, 500)
      );
      return {
        videos: [],
        meta: {
          channelId,
          title: "",
          thumbnail: undefined,
          avatar: undefined,
        },
      };
    }

    const xmlText = await response.text();
    console.log(`[RSS] ✓ Received ${xmlText.length} bytes`);
    console.log(`[RSS] First 500 characters:`, xmlText.substring(0, 500));

    // Check if response is actually XML or an error page
    if (!xmlText.includes("<entry") && !xmlText.includes("<?xml")) {
      console.error(`[RSS] ❌ Response is not valid XML for ${channelId}`);
      console.error(`[RSS] Response preview:`, xmlText.substring(0, 1000));
      return {
        videos: [],
        meta: {
          channelId,
          title: "",
          thumbnail: undefined,
          avatar: undefined,
        },
      };
    }

    const feed = parseRSSXML(xmlText);
    console.log(`[RSS] Parsed feed:`, {
      hasEntries: !!feed.feed?.entry,
      entryCount: feed.feed?.entry?.length || 0,
      title: feed.feed?.title,
    });

    if (!feed.feed || !feed.feed.entry || feed.feed.entry.length === 0) {
      console.warn(`[RSS] ⚠️  No entries found in feed for ${channelId}`);
      return {
        videos: [],
        meta: {
          channelId,
          title: feed.feed?.title || "",
          avatar: feed.feed?.logo,
          thumbnail: feed.feed?.logo,
        },
      };
    }

    const videos: FeedVideo[] = feed.feed.entry
      .map((entry): FeedVideo | null => {
        const videoId = entry["yt:videoid"];
        if (!videoId) return null;

        return {
          id: videoId,
          title: entry.title || "Untitled",
          channelId: entry["yt:channelid"] || channelId,
          channelTitle: entry.author || feed.feed?.title || "Unknown Channel",
          publishedAt:
            entry["yt:uploadedtime"] ||
            entry.pubDate ||
            new Date().toISOString(),
          updatedAt: entry["yt:uploadedtime"],
          url: entry.link || `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail: extractThumbnailUrl(
            videoId,
            entry["media:thumbnail"]?.$?.url
          ),
          // RSS feeds don't provide duration - explicitly undefined
          duration: undefined,
          viewCount: undefined,
          views: undefined,
        };
      })
      .filter((v): v is FeedVideo => v !== null);

    return {
      videos,
      meta: {
        channelId,
        title: feed.feed.title || "",
        avatar: feed.feed.logo,
        thumbnail: feed.feed.logo,
      },
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[RSS] ❌ Exception fetching ${channelId}: ${errorMsg}`);
    console.error(`[RSS] Error stack:`, error);
    return {
      videos: [],
      meta: {
        channelId,
        title: "",
        thumbnail: undefined,
        avatar: undefined,
      },
    };
  }
}

/**
 * Fetch user feed using RSS
 */
export async function fetchUserFeedRss(handle: string): Promise<FetchResult> {
  try {
    const rssUrl = getUserRssUrl(handle);
    console.log(`[RSS] Fetching user from: ${rssUrl}`);

    const response = await fetch(rssUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch RSS feed: HTTP ${response.status} ${response.statusText}`
      );
    }

    const xmlText = await response.text();
    const feed = parseRSSXML(xmlText);

    if (!feed.feed || !feed.feed.entry) {
      console.warn(`[RSS] No entries found in feed for user ${handle}`);
      return {
        videos: [],
        meta: {
          channelId: "",
          title: feed.feed?.title || "",
          avatar: feed.feed?.logo,
          thumbnail: feed.feed?.logo,
        },
      };
    }

    const videos: FeedVideo[] = feed.feed.entry
      .map((entry): FeedVideo | null => {
        const videoId = entry["yt:videoid"];
        if (!videoId) return null;

        return {
          id: videoId,
          title: entry.title || "Untitled",
          channelId: entry["yt:channelid"] || "",
          channelTitle: entry.author || feed.feed?.title || "Unknown Channel",
          publishedAt:
            entry["yt:uploadedtime"] ||
            entry.pubDate ||
            new Date().toISOString(),
          updatedAt: entry["yt:uploadedtime"],
          url: entry.link || `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail: extractThumbnailUrl(
            videoId,
            entry["media:thumbnail"]?.$?.url
          ),
          duration: undefined,
          viewCount: undefined,
          views: undefined,
        };
      })
      .filter((v): v is FeedVideo => v !== null);

    console.log(
      `[RSS] Successfully fetched ${videos.length} videos for user ${handle}`
    );

    return {
      videos,
      meta: {
        channelId: feed.feed["yt:channelid"] || "",
        title: feed.feed.title || "",
        avatar: feed.feed.logo,
        thumbnail: feed.feed.logo,
      },
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[RSS] Failed to fetch user ${handle}: ${errorMsg}`);
    // Return empty result instead of throwing
    return {
      videos: [],
      meta: {
        channelId: "",
        title: "",
        thumbnail: undefined,
        avatar: undefined,
      },
    };
  }
}
