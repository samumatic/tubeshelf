import { NextResponse } from "next/server";
import { readLists } from "@/lib/subscriptionListStore";
import { requireUser } from "@/lib/apiAuth";

function asOpml(items: Array<{ title: string; channelId: string; url: string }>) {
  const outlines = items
    .map((item) => {
      const escapedTitle = item.title
        .replaceAll("&", "&amp;")
        .replaceAll("\"", "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      const xmlUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${item.channelId}`;
      return `    <outline text=\"${escapedTitle}\" title=\"${escapedTitle}\" type=\"rss\" xmlUrl=\"${xmlUrl}\" htmlUrl=\"${item.url}\" />`;
    })
    .join("\n");

  return `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n  <head>\n    <title>TubeShelf Subscriptions</title>\n  </head>\n  <body>\n${outlines}\n  </body>\n</opml>\n`;
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const { searchParams } = new URL(req.url);
  const format = (searchParams.get("format") || "opml").toLowerCase();
  const listId = (searchParams.get("listId") || "all").trim();

  const listsData = await readLists(user.id);
  const targetLists =
    listId === "all"
      ? listsData.lists
      : listsData.lists.filter((list) => list.id === listId);

  const channelMap = new Map<string, { title: string; channelId: string; url: string }>();
  for (const list of targetLists) {
    for (const sub of list.subscriptions) {
      if (!channelMap.has(sub.channelId)) {
        channelMap.set(sub.channelId, {
          title: sub.title,
          channelId: sub.channelId,
          url: sub.url,
        });
      }
    }
  }

  const items = [...channelMap.values()];

  if (format === "json") {
    return new Response(JSON.stringify(items, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const opml = asOpml(items);
  return new Response(opml, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
