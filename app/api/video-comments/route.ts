import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { fetchVideoComments, type CommentSort } from "@/lib/videoComments";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    if (user instanceof NextResponse) return user;

    const searchParams = request.nextUrl.searchParams;
    const videoId = (searchParams.get("videoId") || "").trim();
    const pageToken = (searchParams.get("pageToken") || "").trim() || undefined;
    const sortParam = (searchParams.get("sort") || "top").trim().toLowerCase();
    const sort: CommentSort = sortParam === "new" ? "new" : "top";

    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return NextResponse.json(
        { error: "Invalid or missing videoId" },
        { status: 400 }
      );
    }

    const result = await fetchVideoComments({
      videoId,
      sort,
      pageToken,
    });

    return NextResponse.json(result, {
      headers: {
        "cache-control": "private, max-age=30",
      },
    });
  } catch (error) {
    console.error("[VideoComments] GET error:", error);

    return NextResponse.json(
      { error: "Failed to load comments" },
      { status: 500 }
    );
  }
}
