import { randomUUID } from "node:crypto";
import { SYSTEM_PROMPT, ticketPrompt } from "./prompt.ts";
import { costUsd } from "./providers/pricing.ts";
import type { LLMProvider, Message } from "./providers/types.ts";
import type { ShopClient } from "./shop.ts";
import { TERMINAL_TOOL, toolSpecs } from "./tools/definitions.ts";
import { ToolExecutor, type ExecutedCall } from "./tools/executor.ts";
import { persistTrace, type Outcome, type Trace, type TraceStep } from "./trace.ts";

export interface Ticket {
  id: string;
  customerEmail: string;
  message: string;
}

export interface RunOptions {
  provider: LLMProvider;
  shop: ShopClient;
  /** LLM turns before plain code gives up and escalates. */
  maxSteps?: number;
  /** The eval harness measures disabled providers too; production never sets this. */
  ignoreKillSwitch?: boolean;
  persist?: boolean;
}

export const SAFE_ESCALATION_REPLY =
  "Thanks for reaching out. I've passed your request to our support team, and a person will get back to you shortly.";

// Replies that claim money has moved or will move. Only a human can promise that.
const REFUND_PROMISE = [
  /\b(refund|credit|reimbursement)s?\b[^.!?]{0,40}\b(has been|have been|was|is being|will be)\s+(issued|processed|sent|applied|approved|credited)\b/i,
  /\bI(?:'ve| have)?\s+(issued|processed|approved)\s+(?:a|an|the|your)?\s*(?:full |partial )?(refund|credit)\b/i,
  /\byou(?:'ll| will)\s+(?:be refunded|receive (?:a|your) (?:full |partial )?refund)\b/i,
];

export function promisesRefund(text: string): boolean {
  return REFUND_PROMISE.some((re) => re.test(text));
}

/**
 * Runs one ticket to completion. The LLM chooses which tools to call and in
 * what order; this function enforces the loop budget, the kill switch and
 * the post-run checks, and records everything in a trace.
 */
export async function runAgent(ticket: Ticket, opts: RunOptions): Promise<Trace> {
  const { provider, shop } = opts;
  const maxSteps = opts.maxSteps ?? 8;
  const started = performance.now();
  const steps: TraceStep[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, llmCalls: 0 };
  const executor = new ToolExecutor({ shop, customerEmail: ticket.customerEmail, ticketId: ticket.id });

  let reply = "";
  let finalReason = "";
  let finalOutcome: "resolved" | "needs_info" | undefined;
  let escalation: Trace["escalation"];
  let step = 0;

  const recordTool = (c: ExecutedCall) => {
    steps.push({
      kind: "tool",
      step,
      name: c.name,
      args: c.args,
      reason: c.reason,
      ok: c.result.ok,
      mutating: c.mutating,
      refusedBy: c.refusedBy,
      errorCode: c.result.ok ? undefined : c.result.error.code,
      result: c.result,
      latencyMs: c.latencyMs,
    });
    if (c.name === "escalateToHuman" && c.result.ok) {
      const data = c.result.data as { id?: string; category: string; reason: string };
      escalation = { id: data.id, category: data.category, reason: data.reason, byGuardrail: false };
    }
  };

  /** Plain-code escalation, used when the LLM path can't be trusted to finish. */
  const forceEscalate = async (rule: string, category: string, why: string) => {
    steps.push({ kind: "guardrail", step, rule, detail: why });
    if (!executor.hasEscalated) {
      const c = await executor.execute({
        id: `guardrail-${step}`,
        name: "escalateToHuman",
        args: { category, reason: `[guardrail:${rule}] ${why}`, summary: `Automatic handoff. Customer wrote: ${ticket.message.slice(0, 400)}` },
      });
      recordTool(c);
      if (escalation) escalation.byGuardrail = true;
      else escalation = { category, reason: why, byGuardrail: true }; // API down: still report it as a handoff
    }
    reply = SAFE_ESCALATION_REPLY;
    finalReason = why;
  };

  // 1. Kill switch (plain code). Fails closed if the status can't be read.
  if (!opts.ignoreKillSwitch) {
    let status: { enabled: boolean; reason: string };
    try {
      status = await shop.agentStatus(provider.name);
    } catch (err) {
      status = { enabled: false, reason: `kill switch unreadable: ${(err as Error).message}` };
    }
    if (!status.enabled) {
      await forceEscalate("kill_switch", "OTHER", `agent disabled for provider ${provider.name}: ${status.reason}`);
      return finish();
    }
  }

  // 2. The agent loop: the LLM decides each step.
  const messages: Message[] = [{ role: "user", content: ticketPrompt(ticket) }];
  let finished = false;
  try {
    while (!finished && step < maxSteps) {
      step++;
      const t0 = performance.now();
      const res = await provider.complete({ system: SYSTEM_PROMPT, messages, tools: toolSpecs });
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.llmCalls++;
      steps.push({
        kind: "llm",
        step,
        latencyMs: Math.round(performance.now() - t0),
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        stopReason: res.stopReason,
        text: res.text,
        toolCalls: res.toolCalls.map((c) => c.name),
      });
      messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls });

      if (res.toolCalls.length === 0) {
        // Model answered in plain text instead of calling respondToCustomer.
        reply = res.text ?? "";
        finalOutcome = "resolved";
        finalReason = "model ended with a plain-text reply";
        finished = true;
        break;
      }

      // Run action tools first, the terminal reply last, whatever order the model used.
      const ordered = [...res.toolCalls].sort((a, b) => Number(a.name === TERMINAL_TOOL) - Number(b.name === TERMINAL_TOOL));
      const results: { callId: string; name: string; content: string }[] = [];
      for (const call of ordered) {
        const c = await executor.execute(call);
        recordTool(c);
        results.push({ callId: call.id, name: call.name, content: JSON.stringify(c.result) });
        if (call.name === TERMINAL_TOOL && c.result.ok && !finished) {
          const a = call.args as { message: string; outcome: "resolved" | "needs_info"; reason: string };
          reply = a.message;
          finalOutcome = a.outcome;
          finalReason = a.reason;
          finished = true;
        }
      }
      messages.push({ role: "tool", results });
    }
  } catch (err) {
    await forceEscalate("provider_error", "OTHER", `LLM provider failed: ${(err as Error).message.slice(0, 300)}`);
    return finish();
  }

  // 3. Post-run checks (plain code).
  if (!finished) {
    await forceEscalate("step_budget", "OTHER", `agent did not finish within ${maxSteps} LLM steps`);
  } else if (promisesRefund(reply)) {
    if (executor.hasEscalated) {
      steps.push({ kind: "guardrail", step, rule: "refund_promise", detail: "reply promised a refund; replaced with a neutral handoff message" });
      reply = SAFE_ESCALATION_REPLY;
    } else {
      await forceEscalate("refund_promise", "REFUND", "reply implied a refund without human approval");
    }
  }
  return finish();

  async function finish(): Promise<Trace> {
    const outcome: Outcome = escalation ? "escalated" : (finalOutcome ?? "resolved");
    const trace: Trace = {
      runId: randomUUID(),
      ticketId: ticket.id,
      provider: provider.name,
      model: provider.model,
      customerEmail: ticket.customerEmail,
      startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(),
      latencyMs: Math.round(performance.now() - started),
      outcome,
      decisionReason: escalation && !escalation.byGuardrail ? escalation.reason : finalReason || escalation?.reason || "",
      reply,
      escalation,
      usage,
      costUsd: costUsd(provider.model, usage),
      steps,
    };
    if (opts.persist !== false) await persistTrace(trace);
    return trace;
  }
}
