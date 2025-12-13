import { NextResponse } from "next/server";
import { readUserState, writeUserState, UserState } from "@/lib/userStateStore";

export async function GET() {
  const state = await readUserState();
  return NextResponse.json(state);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const state: UserState = {
    watchedVideos: Array.isArray(body.watchedVideos) ? body.watchedVideos : [],
    hideWatched:
      typeof body.hideWatched === "boolean" ? body.hideWatched : false,
    filterListId:
      typeof body.filterListId === "string" && body.filterListId.length > 0
        ? body.filterListId
        : "all",
    watchLater: Array.isArray(body.watchLater) ? body.watchLater : [],
  };

  await writeUserState(state);
  return NextResponse.json(state);
}
