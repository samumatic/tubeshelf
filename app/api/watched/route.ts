import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { addWatched, listWatched, parseWatchedBody } from "@/lib/watchedStore";

const MAX_WATCHED_PER_REQUEST = 100000;

/** Lists the user's watched videos. Reachable with an API key. */
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const watched = listWatched(user.id);
  return NextResponse.json({ count: watched.length, watched });
}

/**
 * Marks videos watched (additive: nothing is ever un-watched here). Used by
 * SubRelay to sync watched state in. Reachable with an API key.
 */
export async function PUT(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const entries = parseWatchedBody(body);
  if (!entries) {
    return NextResponse.json(
      { error: 'Expected {"watched": [...]} or an array of video ids' },
      { status: 400 }
    );
  }
  if (entries.length > MAX_WATCHED_PER_REQUEST) {
    return NextResponse.json(
      { error: `At most ${MAX_WATCHED_PER_REQUEST} videos per request` },
      { status: 413 }
    );
  }

  const added = addWatched(user.id, entries);
  return NextResponse.json({
    received: entries.length,
    added,
    total: listWatched(user.id).length,
  });
}
