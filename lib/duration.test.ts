import { describe, expect, it } from "vitest";
import {
  formatDurationText,
  formatVideoDuration,
  formatViewingTime,
  parseDurationText,
  sumViewingTime,
} from "./duration";

describe("parseDurationText", () => {
  it("parses M:SS", () => {
    expect(parseDurationText("4:21")).toBe(4 * 60 + 21);
    expect(parseDurationText("0:09")).toBe(9);
  });

  it("parses H:MM:SS", () => {
    expect(parseDurationText("1:25:03")).toBe(1 * 3600 + 25 * 60 + 3);
    expect(parseDurationText("2:00:00")).toBe(2 * 3600);
  });

  it("rejects anything that isn't strictly M:SS or H:MM:SS", () => {
    expect(parseDurationText("LIVE")).toBeNull();
    expect(parseDurationText("—")).toBeNull();
    expect(parseDurationText("1 hour, 25 minutes")).toBeNull();
    expect(parseDurationText("1:2:03")).toBeNull(); // minutes must be zero-padded
    expect(parseDurationText("1:60")).toBeNull(); // seconds out of range
  });

  it("returns null for empty input", () => {
    expect(parseDurationText(null)).toBeNull();
    expect(parseDurationText(undefined)).toBeNull();
    expect(parseDurationText("")).toBeNull();
  });
});

describe("formatDurationText", () => {
  it("formats under an hour as M:SS", () => {
    expect(formatDurationText(261)).toBe("4:21");
    expect(formatDurationText(9)).toBe("0:09");
  });

  it("formats an hour or more as H:MM:SS", () => {
    expect(formatDurationText(3600)).toBe("1:00:00");
    expect(formatDurationText(5103)).toBe("1:25:03");
  });

  it("floors fractional seconds and clamps negatives to zero", () => {
    expect(formatDurationText(59.9)).toBe("0:59");
    expect(formatDurationText(-5)).toBe("0:00");
  });
});

describe("formatVideoDuration", () => {
  it("rounds up to the next whole minute", () => {
    expect(formatVideoDuration(61)).toBe("2m"); // 1:01 rounds up
    expect(formatVideoDuration(60)).toBe("1m"); // exact minute stays as-is
  });

  it("shows hours and minutes together, dropping a zero minutes part", () => {
    expect(formatVideoDuration(3600)).toBe("1h"); // exactly on the hour
    expect(formatVideoDuration(5100)).toBe("1h 25m");
  });

  it("floors anything under a minute up to 1m rather than 0m", () => {
    expect(formatVideoDuration(5)).toBe("1m");
  });

  it("returns null for unknown or non-positive durations", () => {
    expect(formatVideoDuration(null)).toBeNull();
    expect(formatVideoDuration(undefined)).toBeNull();
    expect(formatVideoDuration(0)).toBeNull();
    expect(formatVideoDuration(-10)).toBeNull();
    expect(formatVideoDuration(NaN)).toBeNull();
  });
});

describe("formatViewingTime", () => {
  it("shows minutes only for short totals", () => {
    expect(formatViewingTime(14 * 60)).toBe("14m");
  });

  it("drops a zero days part but keeps zero in the middle", () => {
    expect(formatViewingTime(7 * 3600 + 14 * 60)).toBe("7h 14m");
    // 2 days, 0 hours, 14 minutes - the zero hour must stay for readability.
    expect(formatViewingTime(2 * 86400 + 14 * 60)).toBe("2d 0h 14m");
  });

  it("shows all three units when all are non-zero", () => {
    expect(formatViewingTime(15 * 86400 + 7 * 3600 + 14 * 60)).toBe(
      "15d 7h 14m"
    );
  });

  it("rounds the total up once at the end, not per video", () => {
    // 90 seconds should round up to 2m, not down to 1m.
    expect(formatViewingTime(90)).toBe("2m");
  });

  it("treats zero or negative totals as 0m", () => {
    expect(formatViewingTime(0)).toBe("0m");
    expect(formatViewingTime(-100)).toBe("0m");
  });
});

describe("sumViewingTime", () => {
  it("sums known durations and reports complete when all are known", () => {
    const result = sumViewingTime([
      { durationSeconds: 60 },
      { durationSeconds: 120 },
    ]);
    expect(result).toEqual({ seconds: 180, complete: true });
  });

  it("marks incomplete when any duration is missing, zero, or invalid", () => {
    expect(
      sumViewingTime([{ durationSeconds: 60 }, { durationSeconds: null }])
        .complete
    ).toBe(false);
    expect(
      sumViewingTime([{ durationSeconds: 60 }, {}]).complete
    ).toBe(false);
    expect(
      sumViewingTime([{ durationSeconds: 60 }, { durationSeconds: 0 }])
        .complete
    ).toBe(false);
  });

  it("still sums the videos it does know about when some are missing", () => {
    const result = sumViewingTime([
      { durationSeconds: 60 },
      { durationSeconds: undefined },
      { durationSeconds: 120 },
    ]);
    expect(result).toEqual({ seconds: 180, complete: false });
  });

  it("returns zero for an empty list", () => {
    expect(sumViewingTime([])).toEqual({ seconds: 0, complete: true });
  });
});
