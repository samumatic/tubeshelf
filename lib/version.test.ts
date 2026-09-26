import { describe, expect, it } from "vitest";
import { formatVersion } from "./version";

describe("formatVersion", () => {
  it("keeps the plain version for release builds", () => {
    expect(formatVersion("1.4.0")).toBe("1.4.0");
    expect(formatVersion("1.4.0", undefined, "7088021abcdef")).toBe("1.4.0");
  });

  it("appends the channel and short commit for dev builds", () => {
    expect(formatVersion("1.4.0", "dev", "7088021abcdef0123")).toBe(
      "1.4.0-dev.7088021"
    );
  });

  it("appends just the channel when no commit is known", () => {
    expect(formatVersion("1.4.0", "dev")).toBe("1.4.0-dev");
  });
});
