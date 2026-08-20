/**
 * Settings shape, defaults and validation.
 *
 * Kept free of database imports so client components can use the defaults and
 * limits without pulling better-sqlite3 into the browser bundle.
 */

export interface AppSettings {
  defaultSortOrder: "newest" | "oldest";
  theme: "light" | "dark" | "system";
  videoPlayerMode: "built-in" | "new-tab";
  defaultPlayerResolution: "360p" | "480p" | "720p" | "1080p";
  sponsorBlockEnabled: boolean;
  playerDebugEnabled: boolean;
  fetchMethod: "standard" | "rss";
  oidcOnly: boolean;
  publicRegistration: boolean;
  /** Instance default for how long videos are kept, in days. 0 = forever. */
  videoRetentionDays: number;
  /** Channels fetched in parallel. */
  feedConcurrency: number;
  /** Timeout for a single channel fetch, in seconds. */
  feedChannelTimeoutSeconds: number;
  /** How long a blocking feed request waits before answering from the cache. */
  feedRequestTimeoutSeconds: number;
  /** Minimum age before a channel is refetched, in minutes. */
  feedRefreshMinutes: number;
  /** Retry interval for channels whose last fetch failed, in minutes. */
  feedErrorRetryMinutes: number;
}

export const defaultSettings: AppSettings = {
  defaultSortOrder: "newest",
  theme: "system",
  videoPlayerMode: "built-in",
  defaultPlayerResolution: "1080p",
  sponsorBlockEnabled: true,
  playerDebugEnabled: false,
  fetchMethod: "standard",
  oidcOnly: false,
  publicRegistration: false,
  videoRetentionDays: 270, // 9 months
  feedConcurrency: 8,
  feedChannelTimeoutSeconds: 15,
  feedRequestTimeoutSeconds: 60,
  feedRefreshMinutes: 15,
  feedErrorRetryMinutes: 5,
};

/** Allowed range for every numeric setting, used by the admin API and readers. */
export const numericSettingLimits = {
  videoRetentionDays: { min: 0, max: 3650 },
  feedConcurrency: { min: 1, max: 32 },
  feedChannelTimeoutSeconds: { min: 5, max: 120 },
  feedRequestTimeoutSeconds: { min: 5, max: 600 },
  feedRefreshMinutes: { min: 1, max: 1440 },
  feedErrorRetryMinutes: { min: 1, max: 1440 },
} as const satisfies Record<string, { min: number; max: number }>;

export type NumericSettingKey = keyof typeof numericSettingLimits;

/**
 * Coerce a stored or submitted value into a valid setting value.
 * Returns null when the input is not a usable number.
 */
export function clampNumericSetting(
  key: NumericSettingKey,
  value: unknown
): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
      ? Number.parseInt(value, 10)
      : NaN;

  if (!Number.isFinite(parsed)) return null;

  const { min, max } = numericSettingLimits[key];
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * Watched threshold bounds, as a share of the video played. Videos are no
 * longer marked watched when the player opens — they cross into "watched" once
 * playback reaches this share (or the video ends).
 */
export const WATCHED_THRESHOLD_DEFAULT = 90;
export const WATCHED_THRESHOLD_MIN = 25;
export const WATCHED_THRESHOLD_MAX = 100;

export function clampWatchedThreshold(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
      ? Number.parseInt(value, 10)
      : NaN;

  if (!Number.isFinite(parsed)) return WATCHED_THRESHOLD_DEFAULT;

  return Math.min(
    WATCHED_THRESHOLD_MAX,
    Math.max(WATCHED_THRESHOLD_MIN, Math.round(parsed))
  );
}

/** Retention windows offered in the UI. 0 = forever. */
export const RETENTION_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 30, label: "1 month" },
  { value: 90, label: "3 months" },
  { value: 180, label: "6 months" },
  { value: 270, label: "9 months" },
  { value: 365, label: "1 year" },
  { value: 730, label: "2 years" },
  { value: 0, label: "Forever" },
];

export function formatRetention(days: number): string {
  return (
    RETENTION_OPTIONS.find((option) => option.value === days)?.label ??
    `${days} days`
  );
}
