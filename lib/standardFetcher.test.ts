import { describe, expect, it } from "vitest";
import {
  parseLockupViewModel,
  parseRelativeTime,
  parseViewCount,
} from "./standardFetcher";

describe("parseRelativeTime", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");

  it("parses each supported unit", () => {
    expect(parseRelativeTime("5 seconds ago", now)).toBe(
      new Date(now - 5000).toISOString()
    );
    expect(parseRelativeTime("2 hours ago", now)).toBe(
      "2026-08-20T10:00:00.000Z" // hour precision, minutes/seconds zeroed
    );
    expect(parseRelativeTime("3 days ago", now)).toBe(
      "2026-08-17T00:00:00.000Z" // day precision, time-of-day zeroed
    );
    expect(parseRelativeTime("1 year ago", now)).toBe(
      "2025-08-20T00:00:00.000Z"
    );
  });

  it("handles the singular form (no trailing s)", () => {
    expect(parseRelativeTime("1 hour ago", now)).toBe(
      "2026-08-20T11:00:00.000Z"
    );
  });

  it("falls back to the reference time for unparseable text", () => {
    expect(parseRelativeTime("Premiered", now)).toBe(new Date(now).toISOString());
    expect(parseRelativeTime("", now)).toBe(new Date(now).toISOString());
  });
});

describe("parseViewCount", () => {
  it("parses plain numbers", () => {
    expect(parseViewCount("428 views")).toBe(428);
  });

  it("applies K/M/B multipliers", () => {
    expect(parseViewCount("46.9K views")).toBe(46900);
    expect(parseViewCount("1.7M views")).toBe(1700000);
    expect(parseViewCount("2B views")).toBe(2000000000);
  });

  it("returns undefined for text with no view count", () => {
    expect(parseViewCount("1 month ago")).toBeUndefined();
    expect(parseViewCount("")).toBeUndefined();
  });
});

describe("parseLockupViewModel", () => {
  const referenceNowMs = Date.parse("2026-08-20T12:00:00.000Z");

  function baseLockup(overrides: Record<string, unknown> = {}) {
    return {
      contentId: "abc123",
      contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
      metadata: {
        lockupMetadataViewModel: {
          title: { content: "A normal video" },
          metadata: {
            contentMetadataViewModel: {
              metadataRows: [
                {
                  metadataParts: [
                    { text: { content: "46.9K views" } },
                    { text: { content: "19 hours ago" } },
                  ],
                },
              ],
            },
          },
        },
      },
      contentImage: {
        thumbnailViewModel: {
          image: { sources: [{ url: "https://i.ytimg.com/vi/abc123/hqdefault.jpg" }] },
          overlays: [
            {
              thumbnailBottomOverlayViewModel: {
                badges: [{ thumbnailBadgeViewModel: { text: "8:25" } }],
              },
            },
          ],
        },
      },
      ...overrides,
    };
  }

  it("parses a normal video", () => {
    const video = parseLockupViewModel(
      baseLockup(),
      "UCchannel",
      "Some Channel",
      referenceNowMs
    );

    expect(video).toEqual({
      id: "abc123",
      title: "A normal video",
      channelId: "UCchannel",
      channelTitle: "Some Channel",
      publishedAt: "2026-08-19T17:00:00.000Z", // 19 hours before reference, hour precision
      url: "https://www.youtube.com/watch?v=abc123",
      thumbnail: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
      duration: "8:25",
      viewCount: 46900,
      isMemberOnly: false,
    });
  });

  it("finds views/time in the second metadata row for a collab video", () => {
    // Regression test: YouTube puts a "Channel A and Channel B" credit line
    // in row 0 for collabs and pushes views/time down to row 1. The parser
    // must not stop at row 0.
    const lockup = baseLockup({
      metadata: {
        lockupMetadataViewModel: {
          title: { content: "A collab video" },
          metadata: {
            contentMetadataViewModel: {
              metadataRows: [
                {
                  metadataParts: [
                    { text: { content: "Daily Dose Of Internet and Daily Dose of Science" } },
                  ],
                },
                {
                  metadataParts: [
                    { text: { content: "1.7M views" } },
                    { text: { content: "1 month ago" } },
                  ],
                },
              ],
            },
          },
        },
      },
    });

    const video = parseLockupViewModel(
      lockup,
      "UCchannel",
      "Some Channel",
      referenceNowMs
    );

    expect(video?.viewCount).toBe(1700000);
    expect(video?.publishedAt).toBe("2026-07-20T00:00:00.000Z");
    // Before the fix this fell through to "now" instead of the real date.
    expect(video?.publishedAt).not.toBe(new Date(referenceNowMs).toISOString());
  });

  it("detects a members-only badge alongside the duration badge", () => {
    const lockup = baseLockup({
      contentImage: {
        thumbnailViewModel: {
          image: { sources: [{ url: "https://i.ytimg.com/vi/abc123/hqdefault.jpg" }] },
          overlays: [
            {
              thumbnailBottomOverlayViewModel: {
                badges: [
                  { thumbnailBadgeViewModel: { text: "8:25" } },
                  { thumbnailBadgeViewModel: { text: "Members only" } },
                ],
              },
            },
          ],
        },
      },
    });

    const video = parseLockupViewModel(
      lockup,
      "UCchannel",
      "Some Channel",
      referenceNowMs
    );

    expect(video?.isMemberOnly).toBe(true);
    expect(video?.duration).toBe("8:25");
  });

  it("returns null for a non-video content type", () => {
    const video = parseLockupViewModel(
      baseLockup({ contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST" }),
      "UCchannel",
      "Some Channel",
      referenceNowMs
    );
    expect(video).toBeNull();
  });

  it("returns null when the video id is missing", () => {
    const video = parseLockupViewModel(
      baseLockup({ contentId: undefined }),
      "UCchannel",
      "Some Channel",
      referenceNowMs
    );
    expect(video).toBeNull();
  });

  it("falls back to a default thumbnail when no image sources are present", () => {
    const lockup = baseLockup({
      contentImage: { thumbnailViewModel: { image: { sources: [] } } },
    });
    const video = parseLockupViewModel(
      lockup,
      "UCchannel",
      "Some Channel",
      referenceNowMs
    );
    expect(video?.thumbnail).toBe(
      "https://i.ytimg.com/vi/abc123/hqdefault.jpg"
    );
  });
});
