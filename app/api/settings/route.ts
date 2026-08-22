import { NextResponse } from "next/server";
import { readSettings, writeSettings, type AppSettings } from "@/lib/settingsStore";
import { getCurrentUser } from "@/lib/currentUser";

const USER_WRITABLE_SETTINGS_KEYS = [
  "defaultSortOrder",
  "theme",
  "videoPlayerMode",
  "defaultPlayerResolution",
  "sponsorBlockEnabled",
  "playerDebugEnabled",
  "captionsEnabled",
  "fetchMethod",
] as const satisfies ReadonlyArray<keyof AppSettings>;

function sanitizeUserSettingsUpdates(input: unknown): Partial<AppSettings> {
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

  if (raw.fetchMethod === "standard" || raw.fetchMethod === "rss") {
    updates.fetchMethod = raw.fetchMethod;
  }

  return updates;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const settings = await readSettings();
  return NextResponse.json(settings);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await req.json();
    const updates = sanitizeUserSettingsUpdates(body);
    const requestedKeys =
      body && typeof body === "object" ? Object.keys(body as Record<string, unknown>) : [];
    const acceptedKeys = USER_WRITABLE_SETTINGS_KEYS.filter((key) => key in updates);

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
