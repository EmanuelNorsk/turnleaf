import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { ROOT } from "../env.js";

/**
 * Multi-provider abstraction for the AI tiers. Every provider speaks the
 * OpenAI-compatible chat-completions dialect (DeepSeek, OpenAI, Anthropic's
 * compatibility endpoint, Cerebras, and any custom base URL), so one client
 * covers them all. The patch protocol relies only on plain text completions —
 * no provider-specific tool calling required.
 */

export type ProviderId = "auto" | "deepseek" | "openai" | "anthropic" | "cerebras" | "custom";
export type Strength = "quick" | "standard" | "deep";

export interface AiSettings {
  provider: ProviderId;
  apiKey: string;
  /** Required for provider "custom"; ignored otherwise. */
  baseUrl?: string;
  /** Overrides the provider's default model. */
  model?: string;
  strength: Strength;
}

const SETTINGS_FILE = path.join(ROOT, ".ai.json");

interface ProviderPreset {
  baseUrl: string;
  /** model per strength — quick/standard/deep can differ (e.g. reasoner models). */
  models: Record<Strength, string>;
}

const PRESETS: Record<Exclude<ProviderId, "auto" | "custom">, ProviderPreset> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    models: { quick: "deepseek-chat", standard: "deepseek-chat", deep: "deepseek-reasoner" },
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    models: { quick: "gpt-5.1", standard: "gpt-5.1", deep: "gpt-5.1" },
  },
  anthropic: {
    // Anthropic's OpenAI-compatible chat completions endpoint.
    baseUrl: "https://api.anthropic.com/v1/",
    models: { quick: "claude-haiku-4-5", standard: "claude-sonnet-5", deep: "claude-opus-4-8" },
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    models: { quick: "llama-3.3-70b", standard: "llama-3.3-70b", deep: "llama-3.3-70b" },
  },
};

/** Key-prefix autodetection — only where the prefix is unambiguous. */
export function detectProvider(apiKey: string): Exclude<ProviderId, "auto" | "custom"> {
  if (apiKey.startsWith("sk-ant-")) return "anthropic";
  if (apiKey.startsWith("csk-")) return "cerebras";
  if (apiKey.startsWith("sk-proj-")) return "openai";
  // "sk-…" is shared by OpenAI and DeepSeek — default to DeepSeek (this app's
  // historical default); pick OpenAI explicitly in settings if that's yours.
  return "deepseek";
}

/** Load .ai.json, falling back to the legacy DEEPSEEK_API_KEY from env/.env.local. */
export function loadAiSettings(): AiSettings {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Partial<AiSettings>;
      return {
        provider: raw.provider ?? "auto",
        apiKey: raw.apiKey ?? "",
        baseUrl: raw.baseUrl,
        model: raw.model || undefined,
        strength: raw.strength ?? "standard",
      };
    } catch {
      // fall through to legacy
    }
  }
  return {
    provider: "auto",
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    strength: "standard",
  };
}

export function saveAiSettings(settings: AiSettings): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export interface ResolvedProvider {
  id: Exclude<ProviderId, "auto">;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function resolveProvider(settings: AiSettings, modelOverride?: string): ResolvedProvider {
  if (!settings.apiKey) {
    throw new Error("No AI API key configured — add one in the app's Settings (or DEEPSEEK_API_KEY in .env.local).");
  }
  const id = settings.provider === "auto" ? detectProvider(settings.apiKey) : settings.provider;
  if (id === "custom") {
    if (!settings.baseUrl) throw new Error("Custom AI provider needs a base URL in Settings.");
    const model = modelOverride || settings.model;
    if (!model) throw new Error("Custom AI provider needs a model name in Settings.");
    return { id, baseUrl: settings.baseUrl, model, apiKey: settings.apiKey };
  }
  const preset = PRESETS[id];
  return {
    id,
    baseUrl: preset.baseUrl,
    model: modelOverride || settings.model || preset.models[settings.strength],
    apiKey: settings.apiKey,
  };
}

export interface ChatProvider {
  name: string;
  complete(system: string, user: string): Promise<string>;
}

export function createProvider(modelOverride?: string, settings: AiSettings = loadAiSettings()): ChatProvider {
  const resolved = resolveProvider(settings, modelOverride);
  const client = new OpenAI({ apiKey: resolved.apiKey, baseURL: resolved.baseUrl });
  return {
    name: `${resolved.id}/${resolved.model}`,
    async complete(system: string, user: string): Promise<string> {
      const messages = [
        { role: "system" as const, content: system },
        { role: "user" as const, content: user },
      ];
      // Some models reject temperature/max_tokens (e.g. OpenAI reasoning
      // models want max_completion_tokens and default temperature) — retry
      // without the offending parameter instead of failing the whole run.
      let params: Record<string, unknown> = { model: resolved.model, temperature: 0, max_tokens: 8192, messages };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await client.chat.completions.create(params as never);
          return (res as OpenAI.ChatCompletion).choices[0]?.message?.content ?? "";
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/max_tokens/i.test(msg) && "max_tokens" in params) {
            const { max_tokens, ...rest } = params;
            params = { ...rest, max_completion_tokens: max_tokens };
          } else if (/temperature/i.test(msg) && "temperature" in params) {
            const { temperature, ...rest } = params;
            params = rest;
          } else {
            throw e;
          }
        }
      }
      throw new Error(`${resolved.id} rejected the request after parameter fallbacks`);
    },
  };
}
