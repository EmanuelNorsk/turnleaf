import { describe, expect, it } from "vitest";
import { detectProvider, resolveProvider, type AiSettings } from "./provider.js";

const base = (over: Partial<AiSettings> = {}): AiSettings => ({
  provider: "auto",
  apiKey: "sk-test",
  strength: "standard",
  ...over,
});

describe("detectProvider", () => {
  it("detects anthropic and cerebras by prefix", () => {
    expect(detectProvider("sk-ant-abc")).toBe("anthropic");
    expect(detectProvider("csk-abc")).toBe("cerebras");
    expect(detectProvider("sk-proj-abc")).toBe("openai");
  });

  it("defaults plain sk- keys to deepseek", () => {
    expect(detectProvider("sk-abc123")).toBe("deepseek");
  });
});

describe("resolveProvider", () => {
  it("throws without a key", () => {
    expect(() => resolveProvider(base({ apiKey: "" }))).toThrow(/API key/);
  });

  it("auto-detects from the key", () => {
    const r = resolveProvider(base({ apiKey: "sk-ant-xyz" }));
    expect(r.id).toBe("anthropic");
    expect(r.baseUrl).toContain("anthropic.com");
  });

  it("explicit provider beats detection", () => {
    expect(resolveProvider(base({ provider: "openai" })).id).toBe("openai");
  });

  it("picks the reasoner model for deepseek at deep strength", () => {
    expect(resolveProvider(base({ strength: "deep" })).model).toBe("deepseek-reasoner");
    expect(resolveProvider(base({ strength: "quick" })).model).toBe("deepseek-chat");
  });

  it("model override wins over strength defaults", () => {
    expect(resolveProvider(base({ strength: "deep" }), "deepseek-chat").model).toBe("deepseek-chat");
  });

  it("custom requires baseUrl and model", () => {
    expect(() => resolveProvider(base({ provider: "custom" }))).toThrow(/base URL/);
    expect(() => resolveProvider(base({ provider: "custom", baseUrl: "https://x" }))).toThrow(/model/);
    const r = resolveProvider(base({ provider: "custom", baseUrl: "https://api.cerebras.ai/v1", model: "llama-3.3-70b" }));
    expect(r.baseUrl).toBe("https://api.cerebras.ai/v1");
    expect(r.model).toBe("llama-3.3-70b");
  });
});
