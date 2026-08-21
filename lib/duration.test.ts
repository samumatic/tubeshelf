import { describe, expect, it } from "vitest";
import {
  formatDurationText,
  formatVideoDuration,
  parseDurationText,
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
