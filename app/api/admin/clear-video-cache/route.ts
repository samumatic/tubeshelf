import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/apiAuth";
import { clearVideoCache } from "@/lib/videoCacheStore";

export async function POST() {
  const user = await requireAdmin();
  if (user instanceof NextResponse) return user;

  const result = clearVideoCache();
  return NextResponse.json({ success: true, ...result });
}
