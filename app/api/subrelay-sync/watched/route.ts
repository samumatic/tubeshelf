import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/apiAuth";
import { runFeedWatchedSync } from "@/lib/subrelaySync";

/**
 * Two-way watched-state sync with SubRelay, called by the feed after every
 * refresh. Always answers 200 with a status - a sync problem must never
 * break the feed - and is throttled server-side, so frequent refreshes are
 * cheap. Returns the ids newly marked watched so the page can merge them in.
 */
export async function POST() {
  const user = await requireSessionUser();
  if (user instanceof NextResponse) return user;
  return NextResponse.json(await runFeedWatchedSync(user.id));
}
