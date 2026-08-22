import { NextResponse } from "next/server";
import { getCurrentUser, type CurrentUser } from "./currentUser";

/**
 * Resolves the current user for an API route, or a ready-to-return 401
 * response if there isn't one. Callers check `instanceof NextResponse`
 * and return it directly to short-circuit the handler.
 */
export async function requireUser(
  request?: Request
): Promise<CurrentUser | NextResponse> {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return user;
}

/** Same as {@link requireUser}, but also requires the user to be an admin. */
export async function requireAdmin(
  request?: Request
): Promise<CurrentUser | NextResponse> {
  const user = await getCurrentUser(request);
  if (!user || !user.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return user;
}
