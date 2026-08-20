/**
 * Standard YouTube data fetcher
 *
 * This module implements a YouTube data fetcher using web scraping techniques:
 * - Direct HTML scraping from YouTube pages
 * - No API keys required
 * - Extracts channel videos, metadata, and durations
 *
 * Unlike RSS feeds which are limited to ~15 recent videos, this can fetch more videos
 * and includes duration data natively.
 */

export interface StandardVideo {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  url: string;
  thumbnail?: string;
  duration?: string;
  viewCount?: number;
  isMemberOnly?: boolean;
}

export interface StandardChannelMeta {
  channelId: string;
  title: string;
  thumbnail?: string;
  avatar?: string;
  subscriberCount?: string;
}

/**
 * Extract initial data from YouTube HTML page
 */
function extractYouTubeInitialData(html: string): any {
  // Try to find ytInitialData in the HTML
  const patterns = [
    /var ytInitialData = ({.+?});/,
    /window\["ytInitialData"\] = ({.+?});/,
    /ytInitialData = ({.+?});<\/script>/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1]);
      } catch (e) {
        console.warn("[StandardFetcher] Failed to parse ytInitialData:", e);
      }
    }
  }

  return null;
}

// duration formatting/parsing helpers were removed as they were unused

/**
 * Parse video renderer data from YouTube's internal format
 */
function parseVideoRenderer(
  renderer: any,
  referenceNowMs: number
): StandardVideo | null {
  try {
    const videoId = renderer.videoId;
    if (!videoId) return null;

    const title =
      renderer.title?.runs?.[0]?.text || renderer.title?.simpleText || "";
    const channelName =
      renderer.ownerText?.runs?.[0]?.text ||
      renderer.shortBylineText?.runs?.[0]?.text ||
      "";
    const channelId =
      renderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint
        ?.browseId ||
      renderer.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint
        ?.browseId ||
      "";

    // Get thumbnail
    const thumbnails = renderer.thumbnail?.thumbnails || [];
    const thumbnail =
      thumbnails.length > 0
        ? thumbnails[thumbnails.length - 1]?.url
        : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    // Parse duration
    let duration: string | undefined;
    const lengthText =
      renderer.lengthText?.simpleText ||
      renderer.lengthText?.accessibility?.accessibilityData?.label;
    if (lengthText) {
      duration = lengthText;
    } else if (renderer.thumbnailOverlays) {
      // Check for duration in thumbnail overlays
      for (const overlay of renderer.thumbnailOverlays) {
        const timeText =
          overlay.thumbnailOverlayTimeStatusRenderer?.text?.simpleText;
        if (timeText) {
          duration = timeText;
          break;
        }
      }
    }

    // Parse published date
    const publishedText = renderer.publishedTimeText?.simpleText || "";
    let publishedAt = new Date().toISOString();

    // Try to parse relative time like "2 hours ago", "3 days ago"
    if (publishedText) {
      const now = new Date(referenceNowMs);
      const timeMatch = publishedText.match(
        /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i
      );
      if (timeMatch) {
        const value = parseInt(timeMatch[1]);
        const unit = timeMatch[2].toLowerCase();

        switch (unit) {
          case "second":
            now.setSeconds(now.getSeconds() - value);
            now.setMilliseconds(0);
            break;
          case "minute":
            now.setMinutes(now.getMinutes() - value);
            now.setSeconds(0, 0);
            break;
          case "hour":
            now.setHours(now.getHours() - value);
            // YouTube only exposes hour precision here; avoid fake minute/second order.
            now.setMinutes(0, 0, 0);
            break;
          case "day":
            now.setDate(now.getDate() - value);
            now.setHours(0, 0, 0, 0);
            break;
          case "week":
            now.setDate(now.getDate() - value * 7);
            now.setHours(0, 0, 0, 0);
            break;
          case "month":
            now.setMonth(now.getMonth() - value);
            now.setHours(0, 0, 0, 0);
            break;
          case "year":
            now.setFullYear(now.getFullYear() - value);
            now.setHours(0, 0, 0, 0);
            break;
        }
        publishedAt = now.toISOString();
      }
    }

    // Parse view count
    let viewCount: number | undefined;
    const viewText =
      renderer.viewCountText?.simpleText ||
      renderer.shortViewCountText?.simpleText ||
      "";
    const viewMatch = viewText.match(/([\d,\.]+)\s*[KMB]?\s*views?/i);
    if (viewMatch) {
      let views = viewMatch[1].replace(/,/g, "");
      const multiplierMatch = viewText.match(/([\d,\.]+)\s*([KMB])\s*views?/i);
      if (multiplierMatch) {
        const base = parseFloat(multiplierMatch[1]);
        const multiplier = multiplierMatch[2];
        if (multiplier === "K") views = String(base * 1000);
        else if (multiplier === "M") views = String(base * 1000000);
        else if (multiplier === "B") views = String(base * 1000000000);
      }
      viewCount = parseInt(views);
    }

    // Detect members-only videos via badges, explicit flags, or embedded text
    let isMemberOnly = false;
    try {
      // Check explicit flags first (most reliable)
      if (
        renderer.isForMembers ||
        renderer.forMembershipsOnly ||
        renderer.membersOnly ||
        renderer.isMembersOnly
      ) {
        isMemberOnly = true;
      }

      // Check badges (second most reliable)
      const badgeCandidates =
        renderer.badges || renderer.ownerBadges || renderer.badgeMeta || [];
      if (Array.isArray(badgeCandidates)) {
        for (const b of badgeCandidates) {
          // Check badge label text
          const label =
            b?.label || b?.metadata?.label || b?.badgeRenderer?.label || "";
          const labelText = (
            typeof label === "string"
              ? label
              : label?.simpleText || label?.runs?.[0]?.text || ""
          ).toLowerCase();

          // Only match if the badge specifically says "members" or "members only"
          if (
            labelText === "members" ||
            labelText === "members only" ||
            labelText === "members-only"
          ) {
            isMemberOnly = true;
            break;
          }

          // Check badge style
          const style =
            b?.badgeRenderer?.style || b?.metadataBadgeRenderer?.style || "";
          if (
            typeof style === "string" &&
            (style === "BADGE_STYLE_TYPE_MEMBERS_ONLY" ||
              style.toLowerCase().includes("member"))
          ) {
            isMemberOnly = true;
            break;
          }

          // Check badge icon type
          const iconType =
            b?.badgeRenderer?.icon?.iconType ||
            b?.metadataBadgeRenderer?.icon?.iconType ||
            "";
          if (iconType === "SPONSORSHIPS" || iconType === "MEMBERS_ONLY") {
            isMemberOnly = true;
            break;
          }
        }
      }

      // Check for thumbnailOverlays which often contain membership indicators
      const overlays = renderer.thumbnailOverlays || [];
      if (Array.isArray(overlays)) {
        for (const overlay of overlays) {
          const text =
            overlay?.thumbnailOverlayBadgeRenderer?.text?.simpleText ||
            overlay?.thumbnailOverlayBadgeRenderer?.text?.runs?.[0]?.text ||
            "";
          if (
            text.toLowerCase() === "members only" ||
            text.toLowerCase() === "members"
          ) {
            isMemberOnly = true;
            break;
          }
        }
      }
    } catch (e) {
      // ignore detection errors
    }

    // Remove the broad text search heuristic - it causes too many false positives

    return {
      id: videoId,
      title,
      channelId,
      channelTitle: channelName,
      publishedAt,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: thumbnail.startsWith("//") ? `https:${thumbnail}` : thumbnail,
      duration,
      viewCount,
      isMemberOnly,
    };
  } catch (error) {
    console.warn("[StandardFetcher] Failed to parse video renderer:", error);
    return null;
  }
}

/**
 * Parse a relative time string ("2 hours ago", "3 days ago") into an ISO
 * timestamp. Shared between the legacy videoRenderer parser and the current
 * lockupViewModel one, since YouTube expresses both the same way.
 */
function parseRelativeTime(text: string, referenceNowMs: number): string {
  const now = new Date(referenceNowMs);
  const timeMatch = text.match(
    /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i
  );
  if (!timeMatch) return now.toISOString();

  const value = parseInt(timeMatch[1]);
  const unit = timeMatch[2].toLowerCase();

  switch (unit) {
    case "second":
      now.setSeconds(now.getSeconds() - value);
      now.setMilliseconds(0);
      break;
    case "minute":
      now.setMinutes(now.getMinutes() - value);
      now.setSeconds(0, 0);
      break;
    case "hour":
      now.setHours(now.getHours() - value);
      // YouTube only exposes hour precision here; avoid fake minute/second order.
      now.setMinutes(0, 0, 0);
      break;
    case "day":
      now.setDate(now.getDate() - value);
      now.setHours(0, 0, 0, 0);
      break;
    case "week":
      now.setDate(now.getDate() - value * 7);
      now.setHours(0, 0, 0, 0);
      break;
    case "month":
      now.setMonth(now.getMonth() - value);
      now.setHours(0, 0, 0, 0);
      break;
    case "year":
      now.setFullYear(now.getFullYear() - value);
      now.setHours(0, 0, 0, 0);
      break;
  }
  return now.toISOString();
}

/**
 * Parse a view-count string ("54K views") into a number. Shared between the
 * legacy videoRenderer parser and the current lockupViewModel one.
 */
function parseViewCount(text: string): number | undefined {
  const viewMatch = text.match(/([\d,\.]+)\s*[KMB]?\s*views?/i);
  if (!viewMatch) return undefined;

  let views = viewMatch[1].replace(/,/g, "");
  const multiplierMatch = text.match(/([\d,\.]+)\s*([KMB])\s*views?/i);
  if (multiplierMatch) {
    const base = parseFloat(multiplierMatch[1]);
    const multiplier = multiplierMatch[2];
    if (multiplier === "K") views = String(base * 1000);
    else if (multiplier === "M") views = String(base * 1000000);
    else if (multiplier === "B") views = String(base * 1000000000);
  }
  return parseInt(views);
}

/**
 * Parse a video entry in YouTube's current channel-page grid format.
 *
 * Replaced `videoRenderer`/`gridVideoRenderer` sometime in 2026: each grid
 * item is now a `lockupViewModel` (YouTube's newer "view model" UI layer),
 * which nests the same information under different, deeper paths. Channel
 * id/title are not repeated per item here (they're implicit - this is
 * already that channel's own page), so they're passed in from the caller.
 */
function parseLockupViewModel(
  lockup: any,
  channelId: string,
  channelTitle: string,
  referenceNowMs: number
): StandardVideo | null {
  try {
    if (lockup.contentType && lockup.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") {
      return null;
    }

    const videoId = lockup.contentId;
    if (!videoId) return null;

    const metadataViewModel = lockup.metadata?.lockupMetadataViewModel;
    const title = metadataViewModel?.title?.content || "";

    // Usually one row of [views, time ago], but a collab video's first row
    // is a "Channel A and Channel B" credit line instead, pushing the
    // views/time row down to index 1 - so every row has to be checked, not
    // just the first.
    const metadataRows: Array<{
      metadataParts?: Array<{ text?: { content?: string } }>;
    }> =
      metadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows ||
      [];
    let viewCount: number | undefined;
    let publishedAt = new Date(referenceNowMs).toISOString();
    for (const row of metadataRows) {
      for (const part of row.metadataParts || []) {
        const text = part.text?.content || "";
        if (/views?$/i.test(text) || /watching$/i.test(text)) {
          viewCount = parseViewCount(text);
        } else if (/ago$/i.test(text)) {
          publishedAt = parseRelativeTime(text, referenceNowMs);
        }
      }
    }

    const thumbnails =
      lockup.contentImage?.thumbnailViewModel?.image?.sources || [];
    const thumbnail =
      thumbnails.length > 0
        ? thumbnails[thumbnails.length - 1]?.url
        : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    // Duration and membership badges both live in the thumbnail overlays;
    // a duration reads "M:SS"/"H:MM:SS", anything else is a status badge.
    let duration: string | undefined;
    let isMemberOnly = false;
    const overlays: any[] =
      lockup.contentImage?.thumbnailViewModel?.overlays || [];
    for (const overlay of overlays) {
      const badges =
        overlay.thumbnailBottomOverlayViewModel?.badges ||
        overlay.thumbnailOverlayBadgeViewModel?.badges ||
        [];
      for (const badge of badges) {
        const text: string =
          badge.thumbnailBadgeViewModel?.text ||
          badge.thumbnailOverlayBadgeViewModel?.text?.simpleText ||
          "";
        if (!text) continue;
        if (/^\d{1,2}(:\d{2}){1,2}$/.test(text)) {
          duration = text;
        } else if (/members?[\s-]?only|^members$/i.test(text)) {
          isMemberOnly = true;
        }
      }
    }

    return {
      id: videoId,
      title,
      channelId,
      channelTitle,
      publishedAt,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: thumbnail?.startsWith("//") ? `https:${thumbnail}` : thumbnail,
      duration,
      viewCount,
      isMemberOnly,
    };
  } catch (error) {
    console.warn("[StandardFetcher] Failed to parse lockupViewModel:", error);
    return null;
  }
}

/**
 * Fetch channel videos using standard web scraping
 */
export async function fetchChannelVideos(
  channelId: string,
  options: {
    limit?: number;
  } = {}
): Promise<{ videos: StandardVideo[]; meta: StandardChannelMeta }> {
  const { limit = 30 } = options;

  const url = `https://www.youtube.com/channel/${channelId}/videos`;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    Cookie: "CONSENT=YES+1",
  };

  try {
    // Debug/info only: fetching starts
    // Use logger so default LOG_LEVEL (error) suppresses this in production
    // and you can enable it with LOG_LEVEL=debug
    const { debug } = await import("@/lib/logger");
    debug(`[StandardFetcher] Fetching videos for channel ${channelId}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

    const response = await fetch(`${url}?hl=en&gl=US`, {
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      // Explicitly log 404s so the container logs contain channel diagnostics
      if (response.status === 404) {
        console.error(
          `[StandardFetcher] Channel page returned 404 for ${channelId} -> ${url}`
        );
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const initialData = extractYouTubeInitialData(html);

    if (!initialData) {
      throw new Error("Failed to extract YouTube data from page");
    }

    // Extract channel metadata
    const channelHeader =
      initialData.header?.c4TabbedHeaderRenderer ||
      initialData.header?.pageHeaderRenderer;
    const channelTitle =
      channelHeader?.title ||
      channelHeader?.content?.pageHeaderViewModel?.title?.dynamicTextViewModel
        ?.text?.content ||
      "";
    const channelAvatar =
      channelHeader?.avatar?.thumbnails?.[0]?.url ||
      channelHeader?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel
        ?.image?.sources?.[0]?.url;
    const subscriberText = channelHeader?.subscriberCountText?.simpleText || "";

    // Find the video list. Each grid item is a `lockupViewModel` as of the
    // current channel-page layout; `videoRenderer`/`gridVideoRenderer` are
    // kept as a fallback in case a request lands on the older layout.
    const tabs =
      initialData.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    let videoRenderers: any[] = [];
    let lockupViewModels: any[] = [];

    for (const tab of tabs) {
      const tabRenderer = tab.tabRenderer;
      if (!tabRenderer || !tabRenderer.selected) continue;

      const content = tabRenderer.content;
      const richGrid = content?.richGridRenderer;
      const sectionList = content?.sectionListRenderer;

      if (richGrid) {
        const contents = richGrid.contents || [];
        for (const item of contents) {
          const itemContent = item.richItemRenderer?.content || {};
          if (itemContent.lockupViewModel) {
            lockupViewModels.push(itemContent.lockupViewModel);
          } else if (itemContent.videoRenderer || itemContent.gridVideoRenderer) {
            videoRenderers.push(
              itemContent.videoRenderer || itemContent.gridVideoRenderer
            );
          }
        }
      } else if (sectionList) {
        const sections = sectionList.contents || [];
        for (const section of sections) {
          const itemSection = section.itemSectionRenderer;
          if (itemSection) {
            const contents = itemSection.contents || [];
            videoRenderers.push(
              ...contents
                .map(
                  (item: any) =>
                    item.videoRenderer || item.gridVideoRenderer || null
                )
                .filter(Boolean)
            );
          }
        }
      }
    }

    // Parse videos
    const referenceNowMs = Date.now();
    const videos = [
      ...lockupViewModels.map((lockup) =>
        parseLockupViewModel(lockup, channelId, channelTitle, referenceNowMs)
      ),
      ...videoRenderers.map((renderer) =>
        parseVideoRenderer(renderer, referenceNowMs)
      ),
    ]
      .filter((v): v is StandardVideo => v !== null)
      .slice(0, limit);

    const { debug: dbg } = await import("@/lib/logger");
    dbg(
      `[StandardFetcher] Found ${videos.length} videos for channel ${channelId}`
    );

    const meta: StandardChannelMeta = {
      channelId,
      title: channelTitle,
      avatar: channelAvatar?.startsWith("//")
        ? `https:${channelAvatar}`
        : channelAvatar,
      thumbnail: channelAvatar?.startsWith("//")
        ? `https:${channelAvatar}`
        : channelAvatar,
      subscriberCount: subscriberText,
    };

    return { videos, meta };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `[StandardFetcher] Failed to fetch channel videos:`,
      errorMsg
    );

    // Return empty result instead of throwing
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
 * Fetch regular videos for a channel
 */
export async function fetchChannelFeed(channelId: string) {
  return fetchChannelVideos(channelId, {});
}

/**
 * Convert standard video format to RSS-compatible format
 */
export function standardToRSSFormat(video: StandardVideo): any {
  return {
    id: video.id,
    videoId: video.id,
    title: video.title,
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    publishedAt: video.publishedAt,
    url: video.url,
    thumbnail: video.thumbnail,
    duration: video.duration,
    viewCount: video.viewCount,
    views: video.viewCount,
    isMemberOnly: !!video.isMemberOnly,
  };
}
