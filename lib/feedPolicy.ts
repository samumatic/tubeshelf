/**
 * Decides how a /api/feed request treats channel refresh work.
 *
 * The rule: if there is anything usable in the cache, serve it right away and
 * let the refresh run in the background. Only a request with nothing to show
 * at all may wait, and only briefly - whatever lands in that window is served,
 * the rest arrives on the client's follow-up cache-only poll.
 */

/** Upper bound on how long a request with an empty cache waits for a refresh. */
export const INITIAL_WAIT_MAX_MS = 5000;

export type FeedMode = "cache-only" | "cache-first" | "blocking";

export interface FeedPolicyInput {
  /** Client follow-up poll: never starts channel fetches. */
  cacheOnly: boolean;
  /** User asked to refresh every channel, ignoring the refresh interval. */
  forceRefresh: boolean;
  /** Cached videos the response could include right now. */
  usableCachedCount: number;
  /** Channels that would be refreshed by this request. */
  staleCount: number;
  /** Admin-configured request timeout, in seconds. */
  requestTimeoutSeconds: number;
}

export interface FeedDecision {
  mode: FeedMode;
  /** Start refreshing the stale channels. */
  refresh: boolean;
  /** How long to wait for the refresh before responding; 0 = don't wait. */
  waitMs: number;
}

export function decideFeedMode(input: FeedPolicyInput): FeedDecision {
  if (input.cacheOnly) {
    return { mode: "cache-only", refresh: false, waitMs: 0 };
  }

  const refresh = input.staleCount > 0;
  if (refresh && input.usableCachedCount === 0) {
    return {
      mode: "blocking",
      refresh,
      waitMs: Math.min(
        INITIAL_WAIT_MAX_MS,
        Math.max(0, input.requestTimeoutSeconds * 1000)
      ),
    };
  }

  return { mode: "cache-first", refresh, waitMs: 0 };
}

/**
 * Wait for `work` for at most `waitMs`. Never rejects and never waits longer
 * than the budget, so a hanging channel fetch cannot hold up a response.
 * Returns true if the work finished within the budget.
 */
export async function waitWithinBudget(
  work: Promise<unknown>,
  waitMs: number
): Promise<boolean> {
  if (waitMs <= 0) return false;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
