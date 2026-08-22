import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { resolveChannelId, fetchChannelFeed } from "@/lib/videoFetcher";
import { addSubscriptionToList } from "@/lib/subscriptionListStore";

function parseCandidates(payload: string): string[] {
  const trimmed = payload.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const candidates = new Set<string>();

      const walk = (value: any) => {
        if (!value) return;

        if (typeof value === "string") {
          candidates.add(value.trim());
          return;
        }

        if (Array.isArray(value)) {
          for (const item of value) walk(item);
          return;
        }

        if (typeof value === "object") {
          if (typeof value.channelId === "string") candidates.add(value.channelId.trim());
          if (typeof value.url === "string") candidates.add(value.url.trim());
          if (typeof value.input === "string") candidates.add(value.input.trim());
          for (const nested of Object.values(value)) walk(nested);
        }
      };

      walk(parsed);
      return [...candidates].filter(Boolean);
    } catch {
      // Fall through to OPML parsing.
    }
  }

  const candidates = new Set<string>();

  const xmlUrlRegex = /xmlUrl\s*=\s*"([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = xmlUrlRegex.exec(trimmed))) {
    candidates.add(match[1]);
  }

  const textRegex = /text\s*=\s*"([^"]+)"/gi;
  while ((match = textRegex.exec(trimmed))) {
    candidates.add(match[1]);
  }

  return [...candidates].filter(Boolean);
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const { searchParams } = new URL(req.url);
  const listId =
    searchParams.get("listId")?.trim() || `default-${user.id}`;

  const payload = await req.text();
  const candidates = parseCandidates(payload);

  if (candidates.length === 0) {
    return NextResponse.json(
      { error: "No subscriptions found in import payload" },
      { status: 400 }
    );
  }

  let added = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const channelId = await resolveChannelId(candidate);
    if (!channelId) {
      skipped += 1;
      continue;
    }

    let title = channelId;
    let thumbnail: string | undefined;

    try {
      const { meta } = await fetchChannelFeed(channelId);
      title = meta?.title || title;
      thumbnail = meta?.thumbnail;
    } catch {
      // Use fallback metadata.
    }

    try {
      await addSubscriptionToList(
        listId,
        {
          id: channelId,
          channelId,
          title,
          url: `https://www.youtube.com/channel/${channelId}`,
          thumbnail,
          addedAt: new Date().toISOString(),
        },
        user.id
      );
      added += 1;
    } catch {
      skipped += 1;
    }
  }

  return NextResponse.json({
    success: true,
    total: candidates.length,
    added,
    skipped,
  });
}
