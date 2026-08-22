import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { readUserState, writeUserState } from "@/lib/userStateStore";
import { clearPlaybackHistory } from "@/lib/playbackHistoryStore";

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const state = await readUserState(user.id);
  await writeUserState(
    {
      ...state,
      watchedVideos: [],
    },
    user.id
  );

  await clearPlaybackHistory(user.id);

  return NextResponse.json({ success: true });
}
