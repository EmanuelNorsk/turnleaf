import { describe, expect, it } from "vitest";
import { isNewer, versionParts } from "./versions.js";

describe("isNewer", () => {
  it("compares numerically per segment", () => {
    expect(isNewer("1.2.10", "1.2.9")).toBe(true);
    expect(isNewer("1.2.9", "1.2.10")).toBe(false);
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
  });

  it("treats missing segments as zero", () => {
    expect(isNewer("1.2", "1.2.0")).toBe(false);
    expect(isNewer("1.2.1", "1.2")).toBe(true);
  });

  it("tolerates a leading v", () => {
    expect(isNewer("v0.4.0", "0.3.0")).toBe(true);
  });

  it("is false for equal versions", () => {
    expect(isNewer("26.1.2", "26.1.2")).toBe(false);
  });

  it("handles the 1.x to 26.x jump", () => {
    expect(isNewer("26.1.2", "1.21.4")).toBe(true);
    expect(versionParts("26.1.2")[0]).toBe(26);
  });
});
