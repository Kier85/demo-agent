import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RefusedBy, ToolResult } from "./tools/executor.ts";

export type Outcome = "resolved" | "needs_info" | "escalated";

export type TraceStep =
  | {
      kind: "llm";
      step: number;
      latencyMs: number;
      inputTokens: number;
      outputTokens: number;
      stopReason: string;
      text?: string;
      toolCalls: string[];
    }
  | {
      kind: "tool";
      step: number;
      name: string;
      args: Record<string, unknown> | undefined;
      reason?: string;
      ok: boolean;
      mutating: boolean;
      refusedBy: RefusedBy;
      errorCode?: string;
      result: ToolResult;
      latencyMs: number;
    }
  | {
      /** Plain-code decision that overrode or completed the LLM's run. */
      kind: "guardrail";
      step: number;
      rule: string;
      detail: string;
    };

export interface Trace {
  runId: string;
  ticketId: string;
  provider: string;
  model: string;
  customerEmail: string;
  startedAt: string;
  latencyMs: number;
  outcome: Outcome;
  /** Why the run ended the way it did: the escalation reason, the final reply's reason, or the guardrail that fired. */
  decisionReason: string;
  reply: string;
  escalation?: { id?: string; category: string; reason: string; byGuardrail: boolean };
  usage: { inputTokens: number; outputTokens: number; llmCalls: number };
  costUsd: number;
  steps: TraceStep[];
}

const TRACE_DIR = process.env.TRACE_DIR ?? path.join(import.meta.dirname, "..", "traces");

/** Writes the trace as pretty JSON and, if TRACE_STDOUT=1, one JSON line to stdout (Cloud Logging picks it up). */
export async function persistTrace(trace: Trace): Promise<string | undefined> {
  if (process.env.TRACE_STDOUT === "1") {
    console.log(JSON.stringify({ severity: "INFO", message: "agent_run", trace }));
  }
  if (process.env.TRACE_DIR === "off") return undefined;
  const dir = path.join(TRACE_DIR, trace.startedAt.slice(0, 10));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${trace.runId}.json`);
  await writeFile(file, JSON.stringify(trace, null, 2));
  return file;
}
