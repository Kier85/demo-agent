import type { Usage } from "./types.ts";

/**
 * List prices in USD per million tokens (standard tier, no caching/batch),
 * checked against the vendors' pricing pages on 2026-10-02. Override with
 * PRICE_<MODEL>_IN / PRICE_<MODEL>_OUT if they change; unknown models are
 * reported with cost 0 and a warning in the eval report.
 */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "gpt-6.1-sol": { in: 2, out: 10 },
  "gpt-6-luna": { in: 0.1, out: 0.5 },
  "gpt-5-mini": { in: 0.25, out: 2 },
  // xAI: prices below the 200k-token prompt threshold.
  "grok-4.3": { in: 1.25, out: 2.5 },
  "grok-4.7": { in: 2, out: 6 },
  mock: { in: 0, out: 0 },
};

function envKey(model: string, dir: "IN" | "OUT"): string {
  return `PRICE_${model.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${dir}`;
}

export function priceFor(model: string): { in: number; out: number } | undefined {
  const envIn = process.env[envKey(model, "IN")];
  const envOut = process.env[envKey(model, "OUT")];
  if (envIn && envOut) return { in: Number(envIn), out: Number(envOut) };
  return PRICES[model];
}

export function costUsd(model: string, usage: Usage): number {
  const p = priceFor(model);
  if (!p) return 0;
  return (usage.inputTokens * p.in + usage.outputTokens * p.out) / 1_000_000;
}
