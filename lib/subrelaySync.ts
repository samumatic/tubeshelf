import { getDb } from "./db";
import {
  mergeListsFromSnapshot,
  readLists,
  type SnapshotChannel,
} from "./subscriptionListStore";
import { addWatched, listWatched, VIDEO_ID_PATTERN } from "./watchedStore";

// Syncs a TubeShelf user with a SubRelay instance, using SubRelay's API-key
// sync API. Both directions are additive - channels, list/group membership,
// and watched videos are only ever added, on either side - so a sync can
// never delete anything.

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_API_KEY_LENGTH = 512;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export interface SubRelaySyncSettings {
  url: string;
  /** Whether a SubRelay API key is saved. The key is never sent to the browser. */
  hasApiKey: boolean;
  syncWatched: boolean;
  lastSyncAt: string | null;
  lastStatus: "success" | "partial" | "error" | null;
  lastMessage: string | null;
}

export interface SubRelaySyncCounts {
  /** Items received from SubRelay. */
  pulled: number;
  /** Of those, how many were new in TubeShelf. */
  addedHere: number;
  /** Items sent to SubRelay. */
  sent: number;
  /** How many were new in SubRelay, or null if they couldn't be sent. */
  addedThere: number | null;
}

export interface SubRelaySyncResult {
  status: "success" | "partial";
  subscriptions: SubRelaySyncCounts & { createdLists: string[] };
  watched: SubRelaySyncCounts | null;
  warnings: string[];
  syncedAt: string;
}

export class SubRelaySyncError extends Error {}

type SettingsRow = {
  url: string;
  api_key: string;
  sync_watched: number;
  last_sync_at: string | null;
  last_status: string | null;
  last_message: string | null;
};

function readRow(userId: string): SettingsRow | undefined {
  return getDb()
    .prepare(
      "SELECT url, api_key, sync_watched, last_sync_at, last_status, last_message FROM subrelay_sync WHERE user_id = ?"
    )
    .get(userId) as SettingsRow | undefined;
}

export function getSubRelaySyncSettings(userId: string): SubRelaySyncSettings {
  const row = readRow(userId);
  const lastStatus = row?.last_status;
  return {
    url: row?.url ?? "",
    hasApiKey: !!row?.api_key,
    syncWatched: row ? row.sync_watched === 1 : true,
    lastSyncAt: row?.last_sync_at ?? null,
    lastStatus:
      lastStatus === "success" || lastStatus === "partial" || lastStatus === "error"
        ? lastStatus
        : null,
    lastMessage: row?.last_message ?? null,
  };
}

/**
 * Validates a SubRelay base URL (e.g. http://subrelay:5173) and returns it
 * without a trailing slash, query, or fragment. Empty stays empty.
 */
export function normalizeSubRelayUrl(raw: unknown): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return "";

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") {
    throw new SubRelaySyncError("SubRelay URL must use http or https");
  }
  const withScheme = scheme ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new SubRelaySyncError("SubRelay URL must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SubRelaySyncError("SubRelay URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new SubRelaySyncError("Put the API key in its own field, not in the URL");
  }
  // Link-local (incl. the 169.254.169.254 cloud metadata endpoint) is never
  // a SubRelay instance.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^169\.254\./.test(host) || host.startsWith("fe80:") || host === "metadata.google.internal") {
    throw new SubRelaySyncError("SubRelay URL can't point at a link-local or cloud metadata address");
  }

  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function originOf(url: string): string {
  try {
    return url ? new URL(url).origin.toLowerCase() : "";
  } catch {
    return "";
  }
}

export function saveSubRelaySyncSettings(
  userId: string,
  input: { url?: unknown; syncWatched?: unknown; apiKey?: unknown; clearApiKey?: unknown }
): SubRelaySyncSettings {
  const current = readRow(userId);
  const url = normalizeSubRelayUrl(input.url);

  const newKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (newKey && (newKey.length > MAX_API_KEY_LENGTH || /\s/.test(newKey))) {
    throw new SubRelaySyncError("That SubRelay API key looks invalid. Paste it exactly as SubRelay showed it.");
  }

  let apiKey = current?.api_key ?? "";
  if (newKey) {
    apiKey = newKey;
  } else if (input.clearApiKey === true) {
    apiKey = "";
  } else if (apiKey && originOf(url) !== originOf(current?.url ?? "")) {
    // A key belongs to one SubRelay instance; don't carry it to another host.
    apiKey = "";
  }

  const syncWatched =
    typeof input.syncWatched === "boolean"
      ? input.syncWatched
      : current
        ? current.sync_watched === 1
        : true;

  getDb()
    .prepare(
      `INSERT INTO subrelay_sync (user_id, url, api_key, sync_watched)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         url = excluded.url, api_key = excluded.api_key, sync_watched = excluded.sync_watched`
    )
    .run(userId, url, apiKey, syncWatched ? 1 : 0);

  return getSubRelaySyncSettings(userId);
}

function recordOutcome(userId: string, status: "success" | "partial" | "error", message: string) {
  getDb()
    .prepare(
      "UPDATE subrelay_sync SET last_sync_at = ?, last_status = ?, last_message = ? WHERE user_id = ?"
    )
    .run(new Date().toISOString(), status, message.slice(0, 500), userId);
}

type SubRelayResponse = { status: number; body: any };

async function subRelayRequest(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<SubRelayResponse> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      // Never follow a redirect with the key attached; a correct URL doesn't redirect.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    const reason = err?.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw new SubRelaySyncError(`SubRelay ${reason} at ${baseUrl}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new SubRelaySyncError(
      `SubRelay redirected the request (HTTP ${response.status}). Check the URL - use the exact address SubRelay is served on.`
    );
  }
  if (response.status === 401) {
    throw new SubRelaySyncError("SubRelay rejected the API key. Create a new one in SubRelay under Settings → API keys.");
  }

  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new SubRelaySyncError(
      `SubRelay returned something other than JSON (HTTP ${response.status}). Check that the URL points at SubRelay.`
    );
  }
  return { status: response.status, body };
}

function errorText(res: SubRelayResponse): string {
  return typeof res.body?.error === "string" ? res.body.error : `HTTP ${res.status}`;
}

function snapshotFromSubRelay(body: any): SnapshotChannel[] {
  const items = Array.isArray(body?.subscriptions) ? body.subscriptions : [];
  const out: SnapshotChannel[] = [];
  for (const item of items) {
    const channelId = typeof item?.channelId === "string" ? item.channelId.trim() : "";
    if (!CHANNEL_ID_PATTERN.test(channelId)) continue;
    out.push({
      channelId,
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : channelId,
      groups: Array.isArray(item.groups)
        ? item.groups.filter((group: unknown): group is string => typeof group === "string")
        : [],
    });
  }
  return out;
}

async function localSnapshot(userId: string): Promise<SnapshotChannel[]> {
  const data = await readLists(userId);
  const byChannel = new Map<string, SnapshotChannel>();
  for (const list of data.lists) {
    // Any list named "Default" (older installs can have one besides the real
    // default list) means "ungrouped", never a SubRelay group called Default.
    const isDefault =
      list.id === data.defaultListId || list.name.trim().toLowerCase() === "default";
    for (const sub of list.subscriptions) {
      const entry = byChannel.get(sub.channelId) ?? {
        channelId: sub.channelId,
        title: sub.title,
        groups: [],
      };
      if (!isDefault && !entry.groups.includes(list.name)) entry.groups.push(list.name);
      byChannel.set(sub.channelId, entry);
    }
  }
  return [...byChannel.values()];
}

const runningSyncs = new Set<string>();

/**
 * Runs one two-way sync for userId. Subscriptions: SubRelay's channels (with
 * groups as lists) are merged into TubeShelf, then TubeShelf's lists are
 * merged into SubRelay. Watched videos (if enabled): the same, both ways.
 *
 * Sending to SubRelay needs an admin SubRelay key; with a regular key the
 * sync still pulls, and reports status "partial".
 */
export async function runSubRelaySync(userId: string): Promise<SubRelaySyncResult> {
  const row = readRow(userId);
  if (!row?.url) throw new SubRelaySyncError("Set your SubRelay URL first");
  if (!row.api_key) throw new SubRelaySyncError("Add a SubRelay API key first");
  if (runningSyncs.has(userId)) throw new SubRelaySyncError("A sync is already running");

  runningSyncs.add(userId);
  try {
    const result = await syncOnce(userId, row.url, row.api_key, row.sync_watched === 1);
    const message = [
      `Subscriptions: ${result.subscriptions.addedHere} new here, ${result.subscriptions.addedThere ?? "none sent"} new in SubRelay.`,
      result.watched
        ? `Watched: ${result.watched.addedHere} new here, ${result.watched.addedThere ?? "none sent"} new in SubRelay.`
        : "",
      ...result.warnings,
    ]
      .filter(Boolean)
      .join(" ");
    recordOutcome(userId, result.status, message);
    return result;
  } catch (err: any) {
    const message = err instanceof SubRelaySyncError ? err.message : "Sync failed unexpectedly";
    recordOutcome(userId, "error", message);
    if (!(err instanceof SubRelaySyncError)) console.error("[SubRelaySync] sync failed", err);
    throw err instanceof SubRelaySyncError ? err : new SubRelaySyncError(message);
  } finally {
    runningSyncs.delete(userId);
  }
}

async function syncOnce(
  userId: string,
  baseUrl: string,
  apiKey: string,
  syncWatched: boolean
): Promise<SubRelaySyncResult> {
  const warnings: string[] = [];
  let sendBlocked = false;

  // 1. Subscriptions from SubRelay into TubeShelf.
  const remoteSubs = await subRelayRequest(baseUrl, apiKey, "/api/sync/subscriptions");
  if (remoteSubs.status !== 200) {
    throw new SubRelaySyncError(`SubRelay refused to list subscriptions: ${errorText(remoteSubs)}`);
  }
  const incoming = snapshotFromSubRelay(remoteSubs.body);
  const merged = await mergeListsFromSnapshot(userId, incoming);

  // 2. TubeShelf's lists into SubRelay (additive merge; lists become groups).
  const outgoing = await localSnapshot(userId);
  let subsAddedThere: number | null = null;
  if (outgoing.length > 0) {
    const pushed = await subRelayRequest(baseUrl, apiKey, "/api/sync/subscriptions", {
      method: "POST",
      body: { mode: "merge", source: "tubeshelf", subscriptions: outgoing },
    });
    if (pushed.status === 403) {
      sendBlocked = true;
    } else if (pushed.status !== 200) {
      warnings.push(`Couldn't send subscriptions to SubRelay: ${errorText(pushed)}`);
    } else {
      subsAddedThere = Number(pushed.body?.diff?.summary?.added ?? 0);
    }
  }

  // 3. Watched videos, both ways.
  let watched: SubRelaySyncCounts | null = null;
  if (syncWatched) {
    const remoteWatched = await subRelayRequest(baseUrl, apiKey, "/api/sync/watched");
    if (remoteWatched.status === 404) {
      warnings.push("This SubRelay version can't sync watched videos yet - update SubRelay.");
    } else if (remoteWatched.status !== 200) {
      warnings.push(`Couldn't read watched videos from SubRelay: ${errorText(remoteWatched)}`);
    } else {
      const entries = (Array.isArray(remoteWatched.body?.watched) ? remoteWatched.body.watched : [])
        .filter((item: any) => typeof item?.videoId === "string" && VIDEO_ID_PATTERN.test(item.videoId))
        .map((item: any) => ({
          videoId: item.videoId as string,
          watchedAt: typeof item.watchedAt === "string" ? item.watchedAt : null,
        }));
      const addedHere = addWatched(userId, entries);

      const local = listWatched(userId);
      let addedThere: number | null = null;
      if (local.length > 0 && !sendBlocked) {
        const pushed = await subRelayRequest(baseUrl, apiKey, "/api/sync/watched?source=tubeshelf", {
          method: "POST",
          body: { watched: local },
        });
        if (pushed.status === 403) {
          sendBlocked = true;
        } else if (pushed.status !== 200) {
          warnings.push(`Couldn't send watched videos to SubRelay: ${errorText(pushed)}`);
        } else {
          addedThere = Number(pushed.body?.added ?? 0);
        }
      }
      watched = { pulled: entries.length, addedHere, sent: local.length, addedThere };
    }
  }

  if (sendBlocked) {
    warnings.unshift(
      "Your SubRelay API key can read but not write, so TubeShelf's changes weren't sent. Use an admin user's SubRelay API key to sync both ways."
    );
  }

  return {
    status: warnings.length > 0 ? "partial" : "success",
    subscriptions: {
      pulled: incoming.length,
      addedHere: merged.addedChannels,
      sent: outgoing.length,
      addedThere: subsAddedThere,
      createdLists: merged.createdLists,
    },
    watched,
    warnings,
    syncedAt: new Date().toISOString(),
  };
}
