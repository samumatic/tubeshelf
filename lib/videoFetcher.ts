/**
 * Video fetcher with switchable backends
 *
 * This module provides video fetching from YouTube using either:
 * - Standard extraction (default, comprehensive)
 * - RSS feeds (fast, limited to recent videos)
 */

import * as standardFetcher from "./standardFetcher";
import * as rssFetcher from "./rssFetcher";
import { readSettings } from "./settingsStore";
import { YOUTUBE_CONSENT_COOKIE } from "./youtubeConsent";

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
  viewCount?: number;
  views?: number;
}

export interface ChannelMeta {
  channelId: string;
  title: string;
  thumbnail?: string;
  avatar?: string;
  subscriberCount?: string;
}

export interface FetchResult {
  videos: FeedVideo[];
  meta: ChannelMeta;
}

/**
 * Get the current fetch method from settings
 */
async function getFetchMethod(): Promise<"standard" | "rss"> {
  try {
    const settings = await readSettings();
    return settings.fetchMethod || "standard";
  } catch {
    return "standard"; // Default to standard method on error
  }
}

/**
 * Fetch channel feed using configured method (standard or RSS)
 */
export async function fetchChannelFeed(
  channelId: string
): Promise<FetchResult> {
  const fetchMethod = await getFetchMethod();

  if (fetchMethod === "rss") {
    // Use RSS fetcher (faster but limited to ~15 recent videos)
    return rssFetcher.fetchChannelFeedRss(channelId);
  } else {
    // Use standard fetcher (default, more comprehensive)
    const result = await standardFetcher.fetchChannelFeed(channelId);
    return {
      videos: result.videos.map(standardFetcher.standardToRSSFormat),
      meta: result.meta,
    };
  }
}

/**
 * Helper function to extract handle from URL path parts
 */
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

/**
 * Extract channel ID without resolving handles
 */
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

/**
 * Resolve YouTube handle to channel ID
 */
async function resolveHandleToChannelId(
  handle: string
): Promise<string | null> {
  const cleanHandle = handle.startsWith("@") ? handle : `@${handle}`;
  const pageUrl = `https://www.youtube.com/${cleanHandle}`;

  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.8",
    cookie: YOUTUBE_CONSENT_COOKIE,
  };

  try {
    const res = await fetch(`${pageUrl}?hl=en&gl=US`, {
      cache: "no-store",
      headers,
    });
    if (!res.ok) {
      console.warn("[ChannelResolver] Handle resolution: Page fetch failed", {
        handle: cleanHandle,
        pageUrl,
        status: res.status,
      });
      return null;
    }
    const html = await res.text();

    // Look for the canonical URL first
    const canonicalMatch = html.match(
      /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/([^"]+)"/
    );
    if (canonicalMatch) {
      const canonicalPath = canonicalMatch[1];
      if (canonicalPath.startsWith("channel/")) {
        const channelId = canonicalPath.replace("channel/", "");
        if (/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
          return channelId;
        }
      }
    }

    // Fallback: Look for ytInitialData
    const initialDataMatch = html.match(/var ytInitialData = ({.*?});/);
    if (initialDataMatch) {
      try {
        const data = JSON.parse(initialDataMatch[1]);
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

    // Fallback: Search for channelId in the initial data
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
    console.error("[ChannelResolver] Handle resolution error", {
      handle: cleanHandle,
      pageUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Extract channel ID from URL or handle
 */
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
