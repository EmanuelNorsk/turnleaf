import { describe, expect, it } from "vitest";
import { parsePluginMeta } from "./scanner.js";

describe("parsePluginMeta", () => {
  it("parses the common fields", () => {
    const m = parsePluginMeta(
      "name: MyPlugin\nversion: 1.2.3\nmain: com.example.Main\napi-version: '1.20'\ndepend: [WolfyUtilities]\nsoftdepend:\n- Vault\n- PlaceholderAPI\n",
    );
    expect(m).toMatchObject({
      name: "MyPlugin",
      version: "1.2.3",
      main: "com.example.Main",
      apiVersion: "1.20",
      foliaSupported: false,
      depend: ["WolfyUtilities"],
      softDepend: ["Vault", "PlaceholderAPI"],
    });
  });

  it("detects folia-supported", () => {
    expect(parsePluginMeta("name: X\nfolia-supported: true\n")?.foliaSupported).toBe(true);
  });

  it("handles a numeric api-version", () => {
    expect(parsePluginMeta("name: X\napi-version: 1.21\n")?.apiVersion).toBe("1.21");
  });

  it("returns null for missing plugin.yml and survives bad yaml", () => {
    expect(parsePluginMeta(null)).toBeNull();
    expect(parsePluginMeta("::: not yaml {{{")?.foliaSupported).toBe(false);
  });
});
