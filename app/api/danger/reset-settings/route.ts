import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { defaultSettings, writeSettings } from "@/lib/settingsStore";
import { readUserState, writeUserState } from "@/lib/userStateStore";

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  await writeSettings(defaultSettings);

  const state = await readUserState(user.id);
  await writeUserState(
    {
      ...state,
      hideWatched: false,
      hideMemberOnly: false,
      filterListId: "all",
    },
    user.id
  );

  return NextResponse.json({ success: true });
}
