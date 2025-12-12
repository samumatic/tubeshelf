import { NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";
import { readLists, addSubscriptionToList } from "@/lib/subscriptionListStore";
import { fetchChannelFeed } from "@/lib/rss";

function collectOutlines(node: any, out: any[] = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((n) => collectOutlines(n, out));
    return out;
  }
  if (node.outline) {
    collectOutlines(node.outline, out);
  }
  if (node.xmlUrl) out.push(node);
  return out;
}

function extractChannelId(xmlUrl: string): string | null {
  try {
    const url = new URL(xmlUrl);
    const cid = url.searchParams.get("channel_id");
    if (cid) return cid;
    // Handle potential path style .../channel/CHANNEL_ID
    const parts = url.pathname.split("/").filter(Boolean);
    const channelIndex = parts.indexOf("channel");
    if (channelIndex >= 0 && parts[channelIndex + 1]) {
      return parts[channelIndex + 1];
    }
    return null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  const body = await req.text().catch(() => "");

  if (!body.trim()) {
    return NextResponse.json({ error: "No content provided" }, { status: 400 });
  }

  let channelItems: { channelId: string; title: string }[] = [];

  try {
    // Handle JSON format (Invidious)
    if (contentType.includes("application/json")) {
      const json = JSON.parse(body);
      if (!json.subscriptions || !Array.isArray(json.subscriptions)) {
        return NextResponse.json(
          { error: "Invalid JSON format: missing subscriptions array" },
          { status: 400 }
        );
      }

      channelItems = json.subscriptions
        .filter((id: any) => typeof id === "string" && id.startsWith("UC"))
        .map((id: string) => ({ channelId: id, title: id }));
    }
    // Handle OPML/XML format
    else {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
      });
      const parsed = parser.parse(body);
      const outlines = collectOutlines(parsed?.opml?.body) as any[];
      const entries = outlines
        .map((o) => ({
          xmlUrl: o.xmlUrl as string | undefined,
          title: (o.title || o.text) as string | undefined,
        }))
        .filter((o) => o.xmlUrl);

      channelItems = entries
        .map((e) => {
          const channelId = extractChannelId(e.xmlUrl!);
          if (!channelId) return null;
          return { channelId, title: e.title || channelId };
        })
        .filter((x): x is { channelId: string; title: string } => !!x);
    }

    if (channelItems.length === 0) {
      return NextResponse.json(
        { error: "No valid channel IDs found" },
        { status: 400 }
      );
    }

    // Get listId from query params or use default
    const url = new URL(req.url);
    const listId = url.searchParams.get("listId") || "default";

    const listsData = await readLists();
    const targetList = listsData.lists.find((l) => l.id === listId);

    if (!targetList) {
      return NextResponse.json(
        { error: "Target list not found" },
        { status: 404 }
      );
    }

    const existingIds = new Set(
      targetList.subscriptions.map((s) => s.channelId)
    );

    let added = 0;
    let skipped = 0;

    for (const item of channelItems) {
      if (existingIds.has(item.channelId)) {
        skipped++;
        continue;
      }
      existingIds.add(item.channelId);

      // Fetch real channel metadata
      let title = item.title;
      let thumbnail: string | undefined;
      try {
        const feed = await fetchChannelFeed(item.channelId);
        if (feed.meta.title) title = feed.meta.title;
        if (feed.meta.thumbnail) thumbnail = feed.meta.thumbnail;
      } catch (e) {
        // Fall back to extracted title if feed fetch fails
      }

      const subscription = {
        id: item.channelId,
        channelId: item.channelId,
        title,
        url: `https://www.youtube.com/channel/${item.channelId}`,
        thumbnail,
        addedAt: new Date().toISOString(),
      };

      await addSubscriptionToList(listId, subscription);
      added++;
    }

    const updatedList = await readLists();
    const finalList = updatedList.lists.find((l) => l.id === listId);

    return NextResponse.json({
      added,
      skipped,
      total: finalList?.subscriptions.length || 0,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to import OPML" },
      { status: 400 }
    );
  }
}
