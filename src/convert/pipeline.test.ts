import { describe, expect, it } from "vitest";
import { parseStamp } from "./pipeline.js";

describe("parseStamp", () => {
  it("parses key=value lines", () => {
    const s = parseStamp("converter-version=0.3.0\npipeline-hash=abc123\noriginal-name=X.jar\n");
    expect(s).toEqual({ "converter-version": "0.3.0", "pipeline-hash": "abc123", "original-name": "X.jar" });
  });

  it("tolerates CRLF and values containing =", () => {
    const s = parseStamp("a=b\r\nurl=https://x?y=1\r\n");
    expect(s?.url).toBe("https://x?y=1");
  });

  it("returns null for null or empty input", () => {
    expect(parseStamp(null)).toBeNull();
    expect(parseStamp("")).toBeNull();
    expect(parseStamp("no separators here")).toBeNull();
  });
});
