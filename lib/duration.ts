/**
 * Duration parsing and formatting.
 *
 * Video lengths are stored as integer seconds (`videos.duration_seconds`);
 * YouTube's display string is kept alongside it only for backwards
 * compatibility. Everything shown to the user is formatted from the seconds.
 *
 * Free of database and React imports so both the server and the browser bundle
 * can use it.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * Parse YouTube's display string into seconds.
 *
 * Deliberately strict: only the `M:SS` and `H:MM:SS` forms are accepted.
 * Anything else (an em-dash placeholder, "LIVE", the localized accessibility
 * wording "1 hour, 25 minutes") returns null so the row stays a backfill
 * candidate and gets an authoritative value instead of a guessed one.
 */
export function parseDurationText(
  text: string | null | undefined
): number | null {
  if (!text) return null;

  const trimmed = text.trim();

  const short = trimmed.match(/^(\d+):([0-5]\d)$/);
  if (short) {
    return Number(short[1]) * MINUTE + Number(short[2]);
  }

  const long = trimmed.match(/^(\d+):([0-5]\d):([0-5]\d)$/);
  if (long) {
    return Number(long[1]) * HOUR + Number(long[2]) * MINUTE + Number(long[3]);
  }

  return null;
}

/**
 * Render seconds as YouTube's display string, so the legacy `duration` column
 * keeps holding what it always held.
 */
export function formatDurationText(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / HOUR);
  const m = Math.floor((total % HOUR) / MINUTE);
  const s = total % MINUTE;
  const pad = (value: number) => String(value).padStart(2, "0");

  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Join non-empty duration components, dropping leading and trailing zero units
 * while keeping zeroes in the middle: `2d 0h 14m` stays readable, `0d 0h 14m`
 * becomes `14m`.
 */
function joinUnits(parts: Array<{ value: number; unit: string }>): string {
  const first = parts.findIndex((part) => part.value > 0);
  if (first === -1) return "0m";

  let last = parts.length - 1;
  while (last > first && parts[last].value === 0) last--;

  return parts
    .slice(first, last + 1)
    .map((part) => `${part.value}${part.unit}`)
    .join(" ");
}

/**
 * Per-video length, rounded up to the next whole minute: `1h 25m`, `26m`, `4m`.
 * Anything shorter than a minute reads `1m` rather than `0m`.
 * Returns null when the length is unknown, so callers can skip the badge.
 */
export function formatVideoDuration(
  seconds: number | null | undefined
): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  const minutes = Math.max(1, Math.ceil(seconds / MINUTE));

  return joinUnits([
    { value: Math.floor(minutes / 60), unit: "h" },
    { value: minutes % 60, unit: "m" },
  ]);
}
