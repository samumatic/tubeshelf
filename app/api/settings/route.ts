import { NextResponse } from "next/server";
import { readSettings, writeSettings, type AppSettings } from "@/lib/settingsStore";
import { requireUser } from "@/lib/apiAuth";

const USER_WRITABLE_SETTINGS_KEYS = [
  "defaultSortOrder",
  "theme",
  "videoPlayerMode",
  "defaultPlayerResolution",
  "sponsorBlockEnabled",
  "playerDebugEnabled",
  "captionsEnabled",
] as const satisfies ReadonlyArray<keyof AppSettings>;

const ADMIN_ONLY_SETTINGS_KEYS = [
  "fetchMethod",
  "oidcOnly",
  "publicRegistration",
  "videoRetentionDays",
  "feedConcurrency",
  "feedChannelTimeoutSeconds",
  "feedRequestTimeoutSeconds",
  "feedRefreshMinutes",
  "feedErrorRetryMinutes",
] as const satisfies ReadonlyArray<keyof AppSettings>;

function sanitizeUserSettingsUpdates(
  input: unknown,
  isAdmin: boolean
): Partial<AppSettings> {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const updates: Partial<AppSettings> = {};

  if (raw.defaultSortOrder === "newest" || raw.defaultSortOrder === "oldest") {
    updates.defaultSortOrder = raw.defaultSortOrder;
  }

  if (raw.theme === "light" || raw.theme === "dark" || raw.theme === "system") {
    updates.theme = raw.theme;
  }

  if (raw.videoPlayerMode === "built-in" || raw.videoPlayerMode === "new-tab") {
    updates.videoPlayerMode = raw.videoPlayerMode;
  }

  if (
    raw.defaultPlayerResolution === "360p" ||
    raw.defaultPlayerResolution === "480p" ||
    raw.defaultPlayerResolution === "720p" ||
    raw.defaultPlayerResolution === "1080p"
  ) {
    updates.defaultPlayerResolution = raw.defaultPlayerResolution;
  }

  if (typeof raw.sponsorBlockEnabled === "boolean") {
    updates.sponsorBlockEnabled = raw.sponsorBlockEnabled;
  }

  if (typeof raw.playerDebugEnabled === "boolean") {
    updates.playerDebugEnabled = raw.playerDebugEnabled;
  }

  if (typeof raw.captionsEnabled === "boolean") {
    updates.captionsEnabled = raw.captionsEnabled;
  }

  if (isAdmin && (raw.fetchMethod === "standard" || raw.fetchMethod === "rss")) {
    updates.fetchMethod = raw.fetchMethod;
  }

  return updates;
}

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const settings = await readSettings();
  return NextResponse.json(settings);
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const body = await req.json();
    const requestedKeys =
      body && typeof body === "object" ? Object.keys(body as Record<string, unknown>) : [];
    if (!user.isAdmin && ADMIN_ONLY_SETTINGS_KEYS.some((key) => requestedKeys.includes(key))) {
      return NextResponse.json(
        { error: "Only admins can change this setting" },
        { status: 403 }
      );
    }
    const updates = sanitizeUserSettingsUpdates(body, user.isAdmin);
    const acceptedKeys = [...USER_WRITABLE_SETTINGS_KEYS, "fetchMethod" as const].filter(
      (key) => key in updates
    );

    if (requestedKeys.length === 0) {
      return NextResponse.json({ error: "No settings provided" }, { status: 400 });
    }
    if (acceptedKeys.length === 0) {
      return NextResponse.json(
        { error: "No valid user settings provided" },
        { status: 400 }
      );
    }

    await writeSettings(updates);
    const updated = await readSettings();
    return NextResponse.json(updated);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to save settings" },
      { status: 400 }
    );
  }
}
