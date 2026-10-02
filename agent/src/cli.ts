// Run one ticket from the terminal and print the trace step by step.
//
//   npm run ticket -- --provider anthropic --email alice@example.com "Where is SM-1001?"
//   npm run ticket -- --provider mock --eval T07        (use a labelled eval ticket)
import "./env.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runAgent } from "./agent.ts";
import { createProvider, isProviderName } from "./providers/index.ts";
import { ShopClient } from "./shop.ts";
import type { Trace } from "./trace.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string", default: process.env.DEFAULT_PROVIDER ?? "anthropic" },
    email: { type: "string" },
    eval: { type: "string" },
    reset: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

if (!isProviderName(values.provider!)) throw new Error(`unknown provider ${values.provider}`);
let ticket = { id: `cli-${Date.now()}`, customerEmail: values.email ?? "", message: positionals.join(" ") };
if (values.eval) {
  const file = JSON.parse(await readFile(path.join(import.meta.dirname, "..", "eval", "tickets.json"), "utf8"));
  const t = file.tickets.find((x: { id: string }) => x.id === values.eval);
  if (!t) throw new Error(`no eval ticket ${values.eval}`);
  ticket = { id: t.id, customerEmail: t.customerEmail, message: t.message };
}
if (!ticket.customerEmail || !ticket.message) {
  console.error('usage: npm run ticket -- --provider mock --email alice@example.com "Where is SM-1001?"');
  process.exit(1);
}

const shop = ShopClient.fromEnv();
if (values.reset) await shop.reset();
const trace = await runAgent(ticket, { provider: createProvider(values.provider), shop });
console.log(values.json ? JSON.stringify(trace, null, 2) : render(trace));

function render(t: Trace): string {
  const out = [`ticket ${t.ticketId}  ${t.customerEmail}  via ${t.provider} (${t.model})`, `> ${ticket.message}`, ""];
  for (const s of t.steps) {
    if (s.kind === "llm") {
      out.push(`[llm ${s.step}] ${s.latencyMs}ms  in=${s.inputTokens} out=${s.outputTokens}  -> ${s.toolCalls.join(", ") || "(text)"}`);
      if (s.text) out.push(`           "${s.text.replace(/\s+/g, " ").slice(0, 160)}"`);
    } else if (s.kind === "tool") {
      const { reason: _r, ...args } = s.args ?? {};
      const status = s.ok ? "ok" : `REFUSED ${s.errorCode}${s.refusedBy ? ` by ${s.refusedBy}` : ""}`;
      out.push(`  [tool] ${s.name}(${JSON.stringify(args)}) -> ${status}`);
      if (s.reason) out.push(`         why: ${s.reason}`);
      if (!s.ok && !s.result.ok) out.push(`         ${s.result.error.message}`);
    } else {
      out.push(`  [guardrail:${s.rule}] ${s.detail}`);
    }
  }
  out.push(
    "",
    `outcome:  ${t.outcome}${t.escalation ? ` (${t.escalation.category}${t.escalation.byGuardrail ? ", by guardrail" : ""})` : ""}`,
    `decision: ${t.decisionReason}`,
    `reply:    ${t.reply}`,
    `latency:  ${t.latencyMs}ms   tokens: ${t.usage.inputTokens} in / ${t.usage.outputTokens} out   cost: $${t.costUsd.toFixed(5)}`,
  );
  return out.join("\n");
}
