import type { Video } from "./apiClient";
import type { AppSettings } from "./settingsStore";
import type { SubscriptionList } from "./subscriptionListStore";

/**
 * Whether two feeds are interchangeable for display purposes.
 *
 * Used to suppress pointless re-renders, so it has to cover every field the UI
 * shows that can change without the video set changing: durations and view
 * counts are backfilled per video well after the video itself is known, so
 * comparing ids alone would pin the feed to its first render.
 */
export function videoListsMatch(arr1?: Video[], arr2?: Video[]): boolean {
  if (arr1 === arr2) return true;
  if (!arr1 || !arr2) return false;
  if (arr1.length !== arr2.length) return false;

  const signature = (v: Video) =>
    `${v.id}:${v.durationSeconds ?? ""}:${v.views ?? ""}`;
  const s = new Set(arr1.map(signature));

  for (const v of arr2) if (!s.has(signature(v))) return false;
  return true;
}

// YouTube's own Shorts length cap (raised from 60s to 3 minutes in 2024).
// There's no other reliable per-video signal available from a channel-page
// scrape - the "Videos" tab and RSS feed both mix Shorts in with everything
// else with no type marker - so duration is the best proxy available.
const SHORTS_MAX_DURATION_SECONDS = 180;

export function isShortVideo(video: Video): boolean {
  return (
    typeof video.durationSeconds === "number" &&
    video.durationSeconds > 0 &&
    video.durationSeconds <= SHORTS_MAX_DURATION_SECONDS
  );
}

/**
 * Filter and sort videos based on various criteria
 */
export function filterAndSortVideos(
  videos: Video[],
  options: {
    searchQuery: string;
    filterListId: string;
    subscriptionLists: SubscriptionList[];
    hideWatched: boolean;
    hideMemberOnly: boolean;
    hideShorts: boolean;
    watchedVideos: Set<string>;
    settings: AppSettings | null;
  }
): Video[] {
  const {
    searchQuery,
    filterListId,
    subscriptionLists,
    hideWatched,
    hideMemberOnly,
    hideShorts,
    watchedVideos,
    settings,
  } = options;

  let vids = [...videos];
  const term = searchQuery.toLowerCase().trim();

  // Filter by subscription list
  if (filterListId !== "all") {
    const selectedList = subscriptionLists.find((l) => l.id === filterListId);
    if (selectedList) {
      const channelIds = new Set(
        selectedList.subscriptions.map((s) => s.channelId)
      );
      vids = vids.filter((v) => channelIds.has(v.channelId));
    } else if (subscriptionLists.length > 0) {
      // List ID is set but list not found, and lists are loaded - show nothing
      vids = [];
    }
    // If subscriptionLists is still empty (loading), skip filtering and show all videos
  }

  // Filter by search term
  if (term) {
    vids = vids.filter(
      (v) =>
        v.title.toLowerCase().includes(term) ||
        v.channel.toLowerCase().includes(term)
    );
  }

  // Filter out watched videos if hideWatched is true
  if (hideWatched) {
    vids = vids.filter((v) => !watchedVideos.has(v.id));
  }

  // Filter out member-only videos if requested
  if (hideMemberOnly) {
    vids = vids.filter((v) => !v.isMemberOnly);
  }

  // Filter out Shorts if requested. A video with unknown duration is kept
  // rather than hidden speculatively - it's usually just waiting on its
  // duration backfill, not necessarily a Short.
  if (hideShorts) {
    vids = vids.filter((v) => !isShortVideo(v));
  }

  // Sort by date (newest first by default, oldest first if setting is "oldest")
  vids = sortVideosByDate(vids, settings?.defaultSortOrder);

  return vids;
}

/**
 * Sort videos by date with stable tie-breaking
 */
function sortVideosByDate(
  videos: Video[],
  sortOrder?: "newest" | "oldest"
): Video[] {
  return [...videos].sort((a, b) => {
    const dateA = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
    const dateB = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
    // Newest first by default
    const comparison = dateB - dateA;
    // If dates are equal, use video ID as stable tie-breaker
    if (comparison === 0) {
      return a.id.localeCompare(b.id);
    }
    // Reverse if oldest first is selected
    return sortOrder === "oldest" ? -comparison : comparison;
  });
}

/**
 * Get the appropriate icon URL based on theme
 */
export function getThemeIconUrl(
  theme: "light" | "dark" | "system",
  mounted: boolean
): string {
  if (theme === "dark") return "/icon-dark.svg";
  if (theme === "light") return "/icon-light.svg";
  // theme === 'system' — avoid reading window on the server to prevent
  // hydration mismatches. Until the component is mounted, return the
  // same value the server would render (light), then after mount use
  // the real prefers-color-scheme value.
  if (!mounted) return "/icon-light.svg";
  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "/icon-dark.svg" : "/icon-light.svg";
}

/**
 * Proxy YouTube-hosted images to avoid browser ORB/CORS issues.
 */
export function getProxiedImageUrl(url?: string | null): string {
  if (!url) return "";
  if (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith("/api/image-proxy")
  ) {
    return url;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (
      host.endsWith("ytimg.com") ||
      host.endsWith("youtube.com") ||
      host.endsWith("yt3.googleusercontent.com") ||
      host.endsWith("googleusercontent.com") ||
      host.endsWith("ggpht.com")
    ) {
      return `/api/image-proxy?url=${encodeURIComponent(url)}`;
    }
  } catch {}
  return url;
}
