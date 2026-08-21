import { NextResponse } from "next/server";
import { readUserState, writeUserState, UserState } from "@/lib/userStateStore";
import { getCurrentUser } from "@/lib/currentUser";
import { clampNumericSetting } from "@/lib/settingsStore";
import { clampWatchedThreshold } from "@/lib/settingsSchema";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const state = await readUserState(user.id);
  return NextResponse.json(state);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Merge partial updates with current persisted state to avoid accidental data loss.
  const current = await readUserState(user.id);
  const nextHasCompletedWelcome =
    body.hasCompletedWelcome === true || body.hasCompletedWelcome === "true"
      ? true
      : body.hasCompletedWelcome === false ||
        body.hasCompletedWelcome === "false"
      ? false
      : !!current.hasCompletedWelcome;

  const nextWatchedVideos: string[] = Array.isArray(body.watchedVideos)
    ? Array.from(
        new Set(
          (body.watchedVideos as unknown[]).filter(
            (id: unknown): id is string => typeof id === "string"
          )
        )
      )
    : current.watchedVideos;

  // null explicitly means "follow the instance default"; anything else keeps
  // the stored value.
  const nextVideoRetentionDays =
    body.videoRetentionDays === null
      ? null
      : body.videoRetentionDays === undefined
      ? current.videoRetentionDays ?? null
      : clampNumericSetting("videoRetentionDays", body.videoRetentionDays);

  const state: UserState = {
    watchedVideos: nextWatchedVideos,
    hideWatched:
      typeof body.hideWatched === "boolean"
        ? body.hideWatched
        : !!current.hideWatched,
    hideMemberOnly:
      typeof body.hideMemberOnly === "boolean"
        ? body.hideMemberOnly
        : !!current.hideMemberOnly,
    hideShorts:
      typeof body.hideShorts === "boolean"
        ? body.hideShorts
        : current.hideShorts ?? true,
    filterListId:
      typeof body.filterListId === "string" && body.filterListId.length > 0
        ? body.filterListId
        : current.filterListId ?? "all",
    hasCompletedWelcome: nextHasCompletedWelcome,
    watchedThresholdPercent: clampWatchedThreshold(
      body.watchedThresholdPercent ?? current.watchedThresholdPercent
    ),
    videoRetentionDays: nextVideoRetentionDays,
    watchLater: Array.isArray(body.watchLater)
      ? body.watchLater
      : current.watchLater ?? [],
  };

  if (state.watchedVideos.length + 10 < current.watchedVideos.length) {
    console.warn("[UserState] Large watchedVideos decrease detected", {
      userId: user.id,
      before: current.watchedVideos.length,
      after: state.watchedVideos.length,
      bodyKeys: Object.keys(body),
    });
  }

  await writeUserState(state, user.id);
  return NextResponse.json(state);
}
