import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./diff.js";

describe("unifiedDiff", () => {
  it("reports no difference for identical inputs", () => {
    expect(unifiedDiff("a\nb\nc", "a\nb\nc")).toBe("(no textual difference after decompilation)");
  });

  it("marks changed lines with - and +", () => {
    const d = unifiedDiff("keep\nold line\nkeep2", "keep\nnew line\nkeep2");
    expect(d).toContain("- old line");
    expect(d).toContain("+ new line");
    expect(d).toContain("  keep");
  });

  it("handles pure additions", () => {
    const d = unifiedDiff("a\nb", "a\nx\nb");
    expect(d).toContain("+ x");
    expect(d).not.toContain("- ");
  });

  it("elides long unchanged runs", () => {
    const mid = Array.from({ length: 50 }, (_, i) => `same${i}`).join("\n");
    const d = unifiedDiff(`first\n${mid}\nlast`, `FIRST\n${mid}\nLAST`);
    expect(d).toContain("…");
    expect(d).toContain("- first");
    expect(d).toContain("+ LAST");
    expect(d.split("\n").length).toBeLessThan(30);
  });

  it("shows the shim redirect pattern clearly", () => {
    const before = `class A {\n  void f() {\n    player.openInventory(menu);\n  }\n}`;
    const after = `import x.foliashim.Shim;\nclass A {\n  void f() {\n    Shim.openInventory(player, menu);\n  }\n}`;
    const d = unifiedDiff(before, after);
    expect(d).toContain("- ");
    expect(d).toContain("+ import x.foliashim.Shim;");
    expect(d).toContain("+     Shim.openInventory(player, menu);");
  });
});
