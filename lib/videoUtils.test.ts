import { describe, expect, it } from "vitest";
import { filterAndSortVideos, isShortVideo } from "./videoUtils";
import type { Video } from "./mockData";

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: overrides.id ?? "v1",
    title: "A video",
    channel: "Some Channel",
    channelId: "UCchannel",
    thumbnail: "https://i.ytimg.com/vi/v1/hqdefault.jpg",
    uploadedAt: "2026-08-01T00:00:00.000Z",
    url: "https://www.youtube.com/watch?v=v1",
    ...overrides,
  };
}

describe("isShortVideo", () => {
  it("treats videos at or under 3 minutes as Shorts", () => {
    expect(isShortVideo(video({ durationSeconds: 1 }))).toBe(true);
    expect(isShortVideo(video({ durationSeconds: 180 }))).toBe(true);
  });

  it("treats videos over 3 minutes as not Shorts", () => {
    expect(isShortVideo(video({ durationSeconds: 181 }))).toBe(false);
    expect(isShortVideo(video({ durationSeconds: 600 }))).toBe(false);
  });

  it("treats unknown, zero, or negative duration as not a Short", () => {
    // Unknown duration is usually just waiting on backfill, not necessarily
    // a Short - don't hide it speculatively.
    expect(isShortVideo(video({ durationSeconds: undefined }))).toBe(false);
    expect(isShortVideo(video({ durationSeconds: 0 }))).toBe(false);
    expect(isShortVideo(video({ durationSeconds: -5 }))).toBe(false);
  });
});

describe("filterAndSortVideos - hideShorts", () => {
  const baseOptions = {
    searchQuery: "",
    filterListId: "all",
    subscriptionLists: [],
    hideWatched: false,
    hideMemberOnly: false,
    watchedVideos: new Set<string>(),
    settings: null,
  };

  it("removes Shorts when hideShorts is true", () => {
    const videos = [
      video({ id: "short", durationSeconds: 45 }),
      video({ id: "long", durationSeconds: 900 }),
    ];

    const result = filterAndSortVideos(videos, {
      ...baseOptions,
      hideShorts: true,
    });

    expect(result.map((v) => v.id)).toEqual(["long"]);
  });

  it("keeps Shorts when hideShorts is false", () => {
    const videos = [
      video({ id: "short", durationSeconds: 45 }),
      video({ id: "long", durationSeconds: 900 }),
    ];

    const result = filterAndSortVideos(videos, {
      ...baseOptions,
      hideShorts: false,
    });

    expect(result.map((v) => v.id).sort()).toEqual(["long", "short"]);
  });

  it("keeps videos with unknown duration even when hideShorts is true", () => {
    const videos = [video({ id: "unknown", durationSeconds: undefined })];

    const result = filterAndSortVideos(videos, {
      ...baseOptions,
      hideShorts: true,
    });

    expect(result.map((v) => v.id)).toEqual(["unknown"]);
  });
});
