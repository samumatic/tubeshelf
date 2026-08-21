/**
 * Feed filter toggles ("Hide watched videos", "Hide member-only videos",
 * "Hide Shorts") are remembered per device rather than per account: the same
 * user usually wants a different default on a phone than on a desktop, and
 * the server copy kept losing the race against the empty defaults on a fresh
 * page load.
 *
 * The stored value wins over whatever /api/user-state returns. A device that
 * has never stored anything falls back to the server value and then adopts it.
 */

const STORAGE_KEY_PREFIX = "tubeshelf.filterPreferences.";

export interface LocalFilterPreferences {
  hideWatched: boolean;
  hideMemberOnly: boolean;
  hideShorts: boolean;
}

function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

/**
 * Returns the toggles stored on this device, or an empty object when nothing is
 * stored (or storage is unavailable, e.g. blocked cookies / private mode).
 */
export function readLocalFilterPreferences(
  userId: string
): Partial<LocalFilterPreferences> {
  if (typeof window === "undefined" || !userId) return {};

  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};

    const prefs: Partial<LocalFilterPreferences> = {};
    if (typeof parsed.hideWatched === "boolean") {
      prefs.hideWatched = parsed.hideWatched;
    }
    if (typeof parsed.hideMemberOnly === "boolean") {
      prefs.hideMemberOnly = parsed.hideMemberOnly;
    }
    if (typeof parsed.hideShorts === "boolean") {
      prefs.hideShorts = parsed.hideShorts;
    }
    return prefs;
  } catch (e) {
    console.error("Failed to read local filter preferences:", e);
    return {};
  }
}

export function writeLocalFilterPreferences(
  userId: string,
  prefs: LocalFilterPreferences
) {
  if (typeof window === "undefined" || !userId) return;

  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(prefs));
  } catch (e) {
    console.error("Failed to save local filter preferences:", e);
  }
}

export function clearLocalFilterPreferences(userId: string) {
  if (typeof window === "undefined" || !userId) return;

  try {
    localStorage.removeItem(storageKey(userId));
  } catch (e) {
    console.error("Failed to clear local filter preferences:", e);
  }
}
