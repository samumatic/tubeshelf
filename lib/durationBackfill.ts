/**
 * Per-video duration backfill.
 *
 * The RSS fetcher cannot report video lengths and the standard fetcher is the
 * only other source, so lengths are resolved one video at a time and stored
 * permanently. Each video is looked up once: the result lands in
 * `videos.duration_seconds` and is never fetched again.
 *
 * Primary source is YouTube's InnerTube player endpoint, which answers with
 * ~14 KB of JSON and still carries `videoDetails.lengthSeconds` even when
 * playback itself is refused. The watch page is the fallback: it always works
 * but costs ~1.3 MB per video.
 */

import {
  getDurationBackfillCandidates,
  markDurationAttemptFailed,
  saveVideoDuration,
} from "./videoCacheStore";

/** Videos resolved per feed request, so a cold start stays a background trickle. */
const BATCH_LIMIT = 50;
const REQUEST_TIMEOUT_MS = 10_000;

/** Public InnerTube web key. Long-lived, but the watch page covers it going stale. */
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20240101.00.00",
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface VideoDetails {
  seconds: number;
  viewCount?: number;
}

function toPositiveInt(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * InnerTube player lookup. Returns null (rather than throwing) whenever the
 * response is unusable, so the caller can fall through to the watch page.
 */
async function fetchViaInnerTube(videoId: string): Promise<VideoDetails | null> {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          videoId,
          context: { client: INNERTUBE_CLIENT },
        }),
      }
    );

    if (!res.ok) return null;

    const data = (await res.json()) as {
      videoDetails?: { lengthSeconds?: string; viewCount?: string };
    };

    const seconds = toPositiveInt(data.videoDetails?.lengthSeconds);
    if (seconds === undefined) return null;

    return { seconds, viewCount: toPositiveInt(data.videoDetails?.viewCount) };
  } catch {
    return null;
  }
}

/**
 * Watch page fallback, using the same scraping approach as the channel avatar
 * lookup in the feed route.
 */
async function fetchViaWatchPage(videoId: string): Promise<VideoDetails | null> {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`,
      {
        headers: {
          "user-agent": USER_AGENT,
          "accept-language": "en-US,en;q=0.8",
          cookie: "CONSENT=YES+1",
        },
      }
    );

    if (!res.ok) return null;

    const html = await res.text();
    const seconds = toPositiveInt(html.match(/"lengthSeconds":"(\d+)"/)?.[1]);
    if (seconds === undefined) return null;

    return {
      seconds,
      viewCount: toPositiveInt(html.match(/"viewCount":"(\d+)"/)?.[1]),
    };
  } catch {
    return null;
  }
}

export async function fetchVideoDetails(
  videoId: string
): Promise<VideoDetails | null> {
  return (await fetchViaInnerTube(videoId)) ?? (await fetchViaWatchPage(videoId));
}

/**
 * Resolve up to BATCH_LIMIT unknown durations for the given channels.
 *
 * Runs in the background: the caller must not await it, and it never throws.
 * Returns how many videos were resolved.
 */
export async function backfillDurations(
  channelIds: string[],
  concurrency: number
): Promise<number> {
  const candidates = getDurationBackfillCandidates(channelIds, BATCH_LIMIT);
  if (candidates.length === 0) return 0;

  const queue = [...candidates];
  let resolved = 0;

  const worker = async () => {
    while (queue.length > 0) {
      const videoId = queue.shift()!;
      try {
        const details = await fetchVideoDetails(videoId);
        if (details) {
          saveVideoDuration(videoId, details.seconds, details.viewCount);
          resolved++;
        } else {
          markDurationAttemptFailed(videoId);
        }
      } catch (err) {
        console.warn(
          `[Duration] Lookup failed for ${videoId}:`,
          err instanceof Error ? err.message : String(err)
        );
        markDurationAttemptFailed(videoId);
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, candidates.length)) },
      worker
    )
  );

  console.log(
    `[Duration] Resolved ${resolved}/${candidates.length} video durations`
  );

  return resolved;
}
