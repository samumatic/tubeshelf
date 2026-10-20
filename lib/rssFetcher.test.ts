import { describe, expect, it } from "vitest";
import {
  decodeXmlEntities,
  getChannelRssUrl,
  parseRSSXML,
} from "./rssFetcher";

describe("decodeXmlEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(
      decodeXmlEntities("Tom &amp; Jerry &lt;3 &gt; &quot;x&quot; &apos;y&apos;")
    ).toBe("Tom & Jerry <3 > \"x\" 'y'");
    expect(decodeXmlEntities("it&#39;s &#x41;")).toBe("it's A");
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeXmlEntities("&nbsp; &#99999999999;")).toBe(
      "&nbsp; &#99999999999;"
    );
  });
});

describe("parseRSSXML", () => {
  it("decodes entities in titles and author", () => {
    const xml = `<feed><yt:channelId>UC1</yt:channelId><title>A &amp; B</title>
<entry><yt:videoId>v1</yt:videoId><title>It&#39;s &lt;fun&gt;</title><author><name>C &amp; D</name></author></entry></feed>`;
    const feed = parseRSSXML(xml);
    expect(feed.feed?.title).toBe("A & B");
    expect(feed.feed?.entry?.[0].title).toBe("It's <fun>");
    expect(feed.feed?.entry?.[0].author).toBe("C & D");
  });
});

describe("getChannelRssUrl", () => {
  it("uses channel_id, not the synthetic UU/UULF uploads-playlist id", () => {
    // YouTube's videos.xml endpoint 404s on playlist_id=UU.../UULF...
    // (confirmed against the live endpoint); channel_id is the only form
    // that still works. Regression test for RSS mode returning 0 videos.
    const url = getChannelRssUrl("UCBJycsmduvYEL83R_U4JriQ");
    expect(url).toBe(
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ"
    );
    expect(url).not.toContain("playlist_id");
  });
});
