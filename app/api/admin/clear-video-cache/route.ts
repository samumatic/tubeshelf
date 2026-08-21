import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/currentUser";
import { clearVideoCache } from "@/lib/videoCacheStore";

export async function POST() {
  const user = await getCurrentUser();
  if (!user || !user.isAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const result = clearVideoCache();
  return NextResponse.json({ success: true, ...result });
}
