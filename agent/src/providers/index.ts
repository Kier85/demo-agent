import { AnthropicProvider } from "./anthropic.ts";
import { MockProvider } from "./mock.ts";
import { OpenAICompatibleProvider } from "./openai.ts";
import type { LLMProvider } from "./types.ts";

export const PROVIDERS = ["anthropic", "openai", "xai", "mock"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function isProviderName(v: string): v is ProviderName {
  return (PROVIDERS as readonly string[]).includes(v);
}

const KEY_VARS: Record<ProviderName, string | undefined> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
  mock: undefined,
};

/** True when the provider's API key is present (mock always is). */
export function hasCredentials(name: ProviderName): boolean {
  const v = KEY_VARS[name];
  return !v || !!process.env[v];
}

function key(name: ProviderName): string {
  const v = KEY_VARS[name]!;
  const k = process.env[v];
  if (!k) throw new Error(`${v} is not set; add it to agent/.env (see .env.example)`);
  return k;
}

/**
 * Builds a provider from environment variables. Base URLs are explicit so a
 * stray ANTHROPIC_BASE_URL / OPENAI_BASE_URL in the shell can't redirect traffic.
 */
export function createProvider(name: ProviderName): LLMProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider({
        apiKey: key(name),
        model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
        baseURL: process.env.AGENT_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      });
    case "openai":
      return new OpenAICompatibleProvider({
        name,
        apiKey: key(name),
        model: process.env.OPENAI_MODEL ?? "gpt-6.1-sol",
        baseURL: process.env.AGENT_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      });
    case "xai":
      return new OpenAICompatibleProvider({
        name,
        apiKey: key(name),
        model: process.env.XAI_MODEL ?? "grok-4.3",
        baseURL: process.env.AGENT_XAI_BASE_URL ?? "https://api.x.ai/v1",
      });
    case "mock":
      return new MockProvider();
  }
}
