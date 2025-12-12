import { readLists } from "@/lib/subscriptionListStore";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") || "opml";
  const listId = searchParams.get("listId") || "all";

  const listsData = await readLists();
  let subs: any[] = [];

  // Get subscriptions from specified list or all lists
  if (listId === "all") {
    // Aggregate all unique subscriptions from all lists
    const uniqueSubs = new Map();
    listsData.lists.forEach((list) => {
      list.subscriptions.forEach((sub) => {
        if (!uniqueSubs.has(sub.channelId)) {
          uniqueSubs.set(sub.channelId, sub);
        }
      });
    });
    subs = Array.from(uniqueSubs.values());
  } else {
    const list = listsData.lists.find((l) => l.id === listId);
    if (list) {
      subs = list.subscriptions;
    }
  }

  // JSON export (Invidious format)
  if (format === "json") {
    const json = {
      subscriptions: subs.map((sub) => sub.channelId),
      watch_history: [],
      preferences: {},
      playlists: [],
    };

    return new Response(JSON.stringify(json, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition":
          "attachment; filename=TubeShelf-Subscriptions.json",
      },
    });
  }

  // OPML export (default)
  const now = new Date().toISOString();
  const outlines = subs
    .map((sub) => {
      const title = escapeXml(sub.title || sub.channelId);
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(
        sub.channelId
      )}`;
      return `<outline text="${title}" title="${title}" type="rss" xmlUrl="${url}" />`;
    })
    .join("\n    ");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>TubeShelf Subscriptions</title>
    <dateCreated>${now}</dateCreated>
  </head>
  <body>
    ${outlines}
  </body>
</opml>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition":
        "attachment; filename=TubeShelf-Subscriptions.opml",
    },
  });
}
