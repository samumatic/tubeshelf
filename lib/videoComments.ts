import { warn } from "@/lib/logger";
import { YOUTUBE_CONSENT_COOKIE } from "@/lib/youtubeConsent";

export type CommentSort = "top" | "new";

export interface VideoComment {
  id: string;
  author: string;
  text: string;
  publishedTime: string;
  likeCountText?: string;
  authorAvatarUrl?: string;
  authorChannelId?: string;
  authorIsCreator?: boolean;
  pinned?: boolean;
  replyCount?: number;
  replyCountText?: string;
  repliesToken?: string;
}

export interface VideoCommentsPage {
  comments: VideoComment[];
  nextPageToken?: string;
  hasMore: boolean;
  disabled?: boolean;
  sortTokens?: Partial<Record<CommentSort, string>>;
}

interface BootstrapData {
  apiKey: string;
  clientVersion: string;
  visitorData?: string;
  initialCommentsToken?: string;
}

const WATCH_HEADERS: HeadersInit = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.8",
  cookie: YOUTUBE_CONSENT_COOKIE,
};

const CONTINUATION_HEADERS_BASE: HeadersInit = {
  ...WATCH_HEADERS,
  "content-type": "application/json",
  origin: "https://www.youtube.com",
  referer: "https://www.youtube.com/",
  "x-youtube-client-name": "1",
};

const REQUEST_TIMEOUT_MS = 12000;
const BOOTSTRAP_CACHE_MS = 10 * 60 * 1000;
const RESPONSE_CACHE_MS = 30 * 1000;
const MAX_CACHE_ENTRIES = 300;
const MAX_COMMENTS_PER_PAGE = 20;

const bootstrapCache = new Map<
  string,
  {
    expiresAt: number;
    data: BootstrapData;
  }
>();

const responseCache = new Map<
  string,
  {
    expiresAt: number;
    data: VideoCommentsPage;
  }
>();

const inFlightRequests = new Map<string, Promise<VideoCommentsPage>>();

function pruneCache<T extends { expiresAt: number }>(
  cache: Map<string, T>,
  maxEntries = MAX_CACHE_ENTRIES
) {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function getCachedResponse(cacheKey: string): VideoCommentsPage | null {
  const cached = responseCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractYouTubeInitialData(html: string): any | null {
  const patterns = [
    /var ytInitialData = (\{.+?\});<\/script>/s,
    /var ytInitialData = (\{.+?\});/s,
    /window\["ytInitialData"\] = (\{.+?\});/s,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      try {
        return JSON.parse(match[1]);
      } catch {
        // Try next pattern
      }
    }
  }

  return null;
}

function normalizeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}

function extractInlineText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node.simpleText === "string") return node.simpleText;
  if (!Array.isArray(node.runs)) return "";

  return node.runs
    .map((run: any) => {
      if (typeof run?.text === "string") return run.text;
      if (Array.isArray(run?.emoji?.shortcuts) && run.emoji.shortcuts[0]) {
        return run.emoji.shortcuts[0];
      }
      return "";
    })
    .join("")
    .trim();
}

function parseLikeCountText(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  return undefined;
}

function parseReplyCount(raw?: string): number | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return undefined;
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractInnertubeConfig(html: string): Omit<BootstrapData, "initialCommentsToken"> {
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const clientVersion =
    html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] ||
    "2.20260201.00.00";
  const visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1];

  if (!apiKey) {
    throw new Error("Failed to extract YouTube API key from watch page");
  }

  return { apiKey, clientVersion, visitorData };
}

function collectContinuationTokens(
  node: any,
  path: string[] = [],
  found: Array<{ token: string; path: string }> = []
): Array<{ token: string; path: string }> {
  if (!node || typeof node !== "object") return found;

  const token = node?.continuationEndpoint?.continuationCommand?.token;
  const apiUrl = node?.continuationEndpoint?.commandMetadata?.webCommandMetadata?.apiUrl;
  if (typeof token === "string" && apiUrl === "/youtubei/v1/next") {
    found.push({ token, path: path.join(".") });
  }

  if (Array.isArray(node)) {
    node.forEach((child, index) =>
      collectContinuationTokens(child, [...path, String(index)], found)
    );
  } else {
    Object.entries(node).forEach(([key, value]) =>
      collectContinuationTokens(value, [...path, key], found)
    );
  }

  return found;
}

function extractInitialCommentsToken(initialData: any): string | undefined {
  const primaryContents =
    initialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents;

  if (Array.isArray(primaryContents)) {
    for (const entry of primaryContents) {
      const section = entry?.itemSectionRenderer;
      if (!section) continue;

      const isCommentsSection =
        section?.targetId === "comments-section" ||
        section?.sectionIdentifier === "comment-item-section";

      if (!isCommentsSection) continue;

      const token = section?.contents
        ?.find((content: any) => content?.continuationItemRenderer)
        ?.continuationItemRenderer?.continuationEndpoint?.continuationCommand
        ?.token;

      if (typeof token === "string" && token.length > 0) {
        return token;
      }
    }
  }

  const engagementToken = initialData?.engagementPanels
    ?.find(
      (panel: any) =>
        panel?.engagementPanelSectionListRenderer?.panelIdentifier ===
        "engagement-panel-comments-section"
    )
    ?.engagementPanelSectionListRenderer?.content?.sectionListRenderer?.contents?.[0]
    ?.itemSectionRenderer?.contents?.[0]?.continuationItemRenderer
    ?.continuationEndpoint?.continuationCommand?.token;

  if (typeof engagementToken === "string" && engagementToken.length > 0) {
    return engagementToken;
  }

  // Last resort: heuristic token scoring
  const candidates = collectContinuationTokens(initialData);
  if (candidates.length === 0) return undefined;

  const scored = candidates
    .map((candidate) => {
      const p = candidate.path;
      let score = 0;
      if (p.includes("comments")) score += 10;
      if (p.includes("twoColumnWatchNextResults.results.results.contents"))
        score += 8;
      if (p.includes("itemSectionRenderer")) score += 4;
      if (p.includes("engagement-panel-comments-section")) score += 3;
      if (p.includes("secondaryResults")) score -= 15;
      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.token;
}

async function getBootstrapData(videoId: string): Promise<BootstrapData> {
  const cached = bootstrapCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(
    videoId
  )}&hl=en&gl=US`;

  const response = await fetchWithTimeout(
    watchUrl,
    {
      method: "GET",
      headers: WATCH_HEADERS,
    },
    REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch YouTube watch page (${response.status})`);
  }

  const html = await response.text();
  const initialData = extractYouTubeInitialData(html);
  const config = extractInnertubeConfig(html);
  const initialCommentsToken = initialData
    ? extractInitialCommentsToken(initialData)
    : undefined;

  const bootstrap: BootstrapData = {
    ...config,
    initialCommentsToken,
  };

  bootstrapCache.set(videoId, {
    expiresAt: Date.now() + BOOTSTRAP_CACHE_MS,
    data: bootstrap,
  });
  pruneCache(bootstrapCache, 150);

  return bootstrap;
}

async function fetchCommentsContinuation(
  bootstrap: BootstrapData,
  continuationToken: string
): Promise<any> {
  const endpoint = `https://www.youtube.com/youtubei/v1/next?key=${encodeURIComponent(
    bootstrap.apiKey
  )}`;

  const body = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: bootstrap.clientVersion,
        hl: "en",
        gl: "US",
        ...(bootstrap.visitorData
          ? { visitorData: bootstrap.visitorData }
          : {}),
      },
    },
    continuation: continuationToken,
  };

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        ...CONTINUATION_HEADERS_BASE,
        "x-youtube-client-version": bootstrap.clientVersion,
      },
      body: JSON.stringify(body),
    },
    REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch YouTube comments (${response.status})`);
  }

  return response.json();
}

function extractContinuationItems(payload: any): any[] {
  const allItems: any[] = [];

  const endpoints = Array.isArray(payload?.onResponseReceivedEndpoints)
    ? payload.onResponseReceivedEndpoints
    : [];

  for (const endpoint of endpoints) {
    const reloadItems = endpoint?.reloadContinuationItemsCommand?.continuationItems;
    if (Array.isArray(reloadItems)) {
      allItems.push(...reloadItems);
    }

    const appendItems = endpoint?.appendContinuationItemsAction?.continuationItems;
    if (Array.isArray(appendItems)) {
      allItems.push(...appendItems);
    }
  }

  const continuationContents = payload?.continuationContents;
  const sectionItems = continuationContents?.itemSectionContinuation?.contents;
  if (Array.isArray(sectionItems)) {
    allItems.push(...sectionItems);
  }

  return allItems;
}

function extractSortTokens(payload: any): Partial<Record<CommentSort, string>> {
  const tokens: Partial<Record<CommentSort, string>> = {};

  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;

    const items = node?.sortFilterSubMenuRenderer?.subMenuItems;
    if (Array.isArray(items)) {
      for (const item of items) {
        const title = String(item?.title || "").toLowerCase();
        const token = item?.serviceEndpoint?.continuationCommand?.token;
        if (typeof token !== "string" || token.length === 0) continue;

        if (title.includes("new")) {
          tokens.new = token;
        } else if (title.includes("top")) {
          tokens.top = token;
        }
      }
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
    } else {
      Object.values(node).forEach(walk);
    }
  };

  walk(payload);
  return tokens;
}

function buildCommentEntityMap(payload: any): Map<string, any> {
  const map = new Map<string, any>();
  const mutations = payload?.frameworkUpdates?.entityBatchUpdate?.mutations;

  if (!Array.isArray(mutations)) {
    return map;
  }

  for (const mutation of mutations) {
    const entity = mutation?.payload?.commentEntityPayload;
    const commentId = entity?.properties?.commentId;
    if (typeof commentId === "string" && commentId.length > 0) {
      map.set(commentId, entity);
    }
  }

  return map;
}

function parseLegacyComment(renderer: any, pinned = false): VideoComment | null {
  const id = renderer?.commentId;
  if (typeof id !== "string" || id.length === 0) return null;

  const author = extractInlineText(renderer?.authorText) || "Unknown";
  const text = extractInlineText(renderer?.contentText);
  if (!text) return null;

  const avatarThumbs = renderer?.authorThumbnail?.thumbnails;
  const avatar = Array.isArray(avatarThumbs)
    ? avatarThumbs[avatarThumbs.length - 1]?.url
    : undefined;

  const published = extractInlineText(renderer?.publishedTimeText);
  const likeCountText = parseLikeCountText(
    renderer?.voteCount?.simpleText ?? renderer?.likeCount
  );

  return {
    id,
    author,
    text,
    publishedTime: published || "",
    likeCountText,
    authorAvatarUrl: normalizeUrl(avatar),
    authorChannelId:
      renderer?.authorEndpoint?.browseEndpoint?.browseId || undefined,
    authorIsCreator: !!renderer?.authorIsChannelOwner,
    pinned,
  };
}

function parseEntityComment(entity: any, pinned = false): VideoComment | null {
  const id = entity?.properties?.commentId;
  const text = entity?.properties?.content?.content;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof text !== "string" || text.trim().length === 0) return null;

  const likeCountText = parseLikeCountText(
    entity?.toolbar?.likeCountNotliked ||
      entity?.toolbar?.likeCountLiked ||
      entity?.toolbar?.likeCountA11y
  );

  return {
    id,
    author: entity?.author?.displayName || "Unknown",
    text,
    publishedTime: entity?.properties?.publishedTime || "",
    likeCountText,
    authorAvatarUrl: normalizeUrl(entity?.author?.avatarThumbnailUrl),
    authorChannelId: entity?.author?.channelId,
    authorIsCreator: !!entity?.author?.isCreator,
    pinned,
  };
}

function getCommentIdFromViewModel(viewModel: any): string | undefined {
  if (!viewModel || typeof viewModel !== "object") return undefined;
  if (typeof viewModel.commentId === "string") return viewModel.commentId;
  if (typeof viewModel.commentViewModel?.commentId === "string") {
    return viewModel.commentViewModel.commentId;
  }
  return undefined;
}

function extractReplyMetaFromThread(thread: any): {
  repliesToken?: string;
  replyCountText?: string;
  replyCount?: number;
} {
  const replies = thread?.replies?.commentRepliesRenderer;
  const repliesToken = replies?.contents
    ?.find((entry: any) => entry?.continuationItemRenderer)
    ?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
  const replyCountText = extractInlineText(
    replies?.viewReplies?.buttonRenderer?.text
  );
  const replyCount = parseReplyCount(replyCountText);

  return {
    repliesToken:
      typeof repliesToken === "string" && repliesToken.length > 0
        ? repliesToken
        : undefined,
    replyCountText: replyCountText || undefined,
    replyCount,
  };
}

function parseCommentsFromPayload(payload: any): {
  comments: VideoComment[];
  nextPageToken?: string;
  sortTokens?: Partial<Record<CommentSort, string>>;
} {
  const continuationItems = extractContinuationItems(payload);
  const entities = buildCommentEntityMap(payload);
  const sortTokens = extractSortTokens(payload);

  const comments: VideoComment[] = [];
  const seen = new Set<string>();

  for (const item of continuationItems) {
    if (comments.length >= MAX_COMMENTS_PER_PAGE) {
      break;
    }

    const thread = item?.commentThreadRenderer;
    if (thread) {
      const legacy = thread?.comment?.commentRenderer;
      const vm = thread?.commentViewModel?.commentViewModel;
      const pinned = !!vm?.pinnedText;
      const replyMeta = extractReplyMetaFromThread(thread);

      const parsedLegacy = legacy ? parseLegacyComment(legacy, pinned) : null;
      if (parsedLegacy && !seen.has(parsedLegacy.id)) {
        seen.add(parsedLegacy.id);
        comments.push({ ...parsedLegacy, ...replyMeta });
        continue;
      }

      const commentId = vm?.commentId;
      if (typeof commentId !== "string") continue;

      const entity = entities.get(commentId);
      if (!entity) continue;

      const parsedEntity = parseEntityComment(entity, pinned);
      if (parsedEntity && !seen.has(parsedEntity.id)) {
        seen.add(parsedEntity.id);
        comments.push({ ...parsedEntity, ...replyMeta });
      }
      continue;
    }

    const commentVm = item?.commentViewModel;
    if (commentVm) {
      const commentId = getCommentIdFromViewModel(commentVm);
      if (!commentId) continue;
      const entity = entities.get(commentId);
      if (!entity) continue;
      const parsedEntity = parseEntityComment(entity, false);
      if (parsedEntity && !seen.has(parsedEntity.id)) {
        seen.add(parsedEntity.id);
        comments.push(parsedEntity);
      }
    }
  }

  const nextPageToken = [...continuationItems]
    .reverse()
    .map(
      (item) =>
        item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand
          ?.token
    )
    .find((token) => typeof token === "string" && token.length > 0);

  return {
    comments,
    nextPageToken,
    sortTokens,
  };
}

export async function fetchVideoComments(options: {
  videoId: string;
  sort?: CommentSort;
  pageToken?: string;
}): Promise<VideoCommentsPage> {
  const { videoId } = options;
  const sort: CommentSort = options.sort === "new" ? "new" : "top";
  const pageToken = options.pageToken?.trim() || undefined;

  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new Error("Invalid YouTube video ID");
  }

  const cacheKey = `${videoId}:${sort}:${pageToken || "initial"}`;
  const cached = getCachedResponse(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = inFlightRequests.get(cacheKey);
  if (pending) {
    return pending;
  }

  const requestPromise = (async () => {
    try {
      const bootstrap = await getBootstrapData(videoId);

      if (pageToken) {
        const payload = await fetchCommentsContinuation(bootstrap, pageToken);
        const parsed = parseCommentsFromPayload(payload);
        const result: VideoCommentsPage = {
          comments: parsed.comments,
          nextPageToken: parsed.nextPageToken,
          hasMore: !!parsed.nextPageToken,
          sortTokens: parsed.sortTokens,
        };

        responseCache.set(cacheKey, {
          expiresAt: Date.now() + RESPONSE_CACHE_MS,
          data: result,
        });
        pruneCache(responseCache);
        return result;
      }

      const initialToken = bootstrap.initialCommentsToken;
      if (!initialToken) {
        const emptyResult: VideoCommentsPage = {
          comments: [],
          hasMore: false,
          disabled: true,
        };

        responseCache.set(cacheKey, {
          expiresAt: Date.now() + RESPONSE_CACHE_MS,
          data: emptyResult,
        });
        pruneCache(responseCache);
        return emptyResult;
      }

      const initialPayload = await fetchCommentsContinuation(bootstrap, initialToken);
      const initialParsed = parseCommentsFromPayload(initialPayload);

      let finalParsed = initialParsed;
      if (sort === "new" && initialParsed.sortTokens?.new) {
        const newestPayload = await fetchCommentsContinuation(
          bootstrap,
          initialParsed.sortTokens.new
        );
        const newestParsed = parseCommentsFromPayload(newestPayload);
        finalParsed = {
          comments: newestParsed.comments,
          nextPageToken: newestParsed.nextPageToken,
          sortTokens: {
            ...initialParsed.sortTokens,
            ...newestParsed.sortTokens,
          },
        };
      }

      const result: VideoCommentsPage = {
        comments: finalParsed.comments,
        nextPageToken: finalParsed.nextPageToken,
        hasMore: !!finalParsed.nextPageToken,
        sortTokens: finalParsed.sortTokens,
        disabled: false,
      };

      responseCache.set(cacheKey, {
        expiresAt: Date.now() + RESPONSE_CACHE_MS,
        data: result,
      });
      pruneCache(responseCache);

      return result;
    } catch (error) {
      warn("[VideoComments] Failed to fetch comments", {
        videoId,
        sort,
        pageToken: pageToken ? "[present]" : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, requestPromise);
  return requestPromise;
}
