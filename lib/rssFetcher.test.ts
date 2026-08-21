import { describe, expect, it } from "vitest";
import { getChannelRssUrl } from "./rssFetcher";

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
