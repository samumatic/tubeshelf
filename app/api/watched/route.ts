import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { addWatchedIds, listWatchedIds, parseWatchedIds } from "@/lib/watchedStore";

const MAX_WATCHED_PER_REQUEST = 100000;

/** Lists the ids of the user's watched videos. Reachable with an API key. */
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const videoIds = listWatchedIds(user.id);
  return NextResponse.json({ count: videoIds.length, videoIds });
}

/**
 * Marks videos watched (additive: nothing is ever un-watched here). Used by
 * SubRelay to sync watched state in. Reachable with an API key.
 */
export async function PUT(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const videoIds = parseWatchedIds(body);
  if (!videoIds) {
    return NextResponse.json(
      { error: 'Expected {"videoIds": [...]} or an array of video ids' },
      { status: 400 }
    );
  }
  if (videoIds.length > MAX_WATCHED_PER_REQUEST) {
    return NextResponse.json(
      { error: `At most ${MAX_WATCHED_PER_REQUEST} videos per request` },
      { status: 413 }
    );
  }

  const added = addWatchedIds(user.id, videoIds);
  return NextResponse.json({
    received: videoIds.length,
    added: added.length,
    total: listWatchedIds(user.id).length,
  });
}
