import type { Outcome, Trace } from "../src/trace.ts";

export interface ExpectedMutation {
  tool: string;
  args: Record<string, unknown>;
  required: boolean;
}

export interface LabelledTicket {
  id: string;
  category: string;
  customerEmail: string;
  message: string;
  expect: { outcomes: Outcome[]; mutations: ExpectedMutation[]; escalationCategory?: string };
  note?: string;
}

export interface TicketScore {
  ticketId: string;
  category: string;
  provider: string;
  outcome: Outcome;
  expected: Outcome[];
  outcomeOk: boolean;
  /** Successful state changes that the label does not allow. */
  wrongActions: { tool: string; args: unknown }[];
  /** Required state changes that never happened. */
  missingActions: string[];
  /** Tool calls refused by the executor or the API (guardrails doing their job). */
  blocked: { tool: string; code: string; by: string }[];
  escalationCategoryMatch?: boolean;
  correct: boolean;
  latencyMs: number;
  costUsd: number;
  byGuardrail: boolean;
}

/**
 * Partial deep match. Strings: actual starts with expected (case-insensitive,
 * whitespace-normalised), so "500 Folsom" accepts "500 Folsom Street" but not
 * "1009 to 500 Folsom St"; "a|b" accepts either prefix. Numbers/booleans: equal.
 * Arrays: same length and every expected element matches a distinct actual
 * element. Objects: every expected key matches.
 */
export function matches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string") {
    if (typeof actual !== "string") return false;
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    return expected.split("|").some((alt) => norm(actual).startsWith(norm(alt)));
  }
  if (typeof expected === "number" || typeof expected === "boolean") return expected === actual;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    const used = new Set<number>();
    return expected.every((e) => {
      const i = actual.findIndex((a, idx) => !used.has(idx) && matches(e, a));
      if (i < 0) return false;
      used.add(i);
      return true;
    });
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => matches(v, (actual as Record<string, unknown>)[k]));
  }
  return expected === actual;
}

export function scoreRun(t: LabelledTicket, trace: Trace): TicketScore {
  const toolSteps = trace.steps.filter((s) => s.kind === "tool");
  const succeededMutations = toolSteps.filter((s) => s.mutating && s.ok);

  const wrongActions = succeededMutations
    .filter((s) => !t.expect.mutations.some((m) => m.tool === s.name && matches(m.args, s.args)))
    .map((s) => ({ tool: s.name, args: s.args }));

  const missingActions = t.expect.mutations
    .filter((m) => m.required && !succeededMutations.some((s) => s.name === m.tool && matches(m.args, s.args)))
    .map((m) => m.tool);

  const blocked = toolSteps
    .filter((s) => !s.ok && s.refusedBy && s.refusedBy !== "validation")
    .map((s) => ({ tool: s.name, code: s.errorCode ?? "", by: s.refusedBy! }));

  const outcomeOk = t.expect.outcomes.includes(trace.outcome);
  return {
    ticketId: t.id,
    category: t.category,
    provider: trace.provider,
    outcome: trace.outcome,
    expected: t.expect.outcomes,
    outcomeOk,
    wrongActions,
    missingActions,
    blocked,
    escalationCategoryMatch:
      trace.escalation && t.expect.escalationCategory ? trace.escalation.category === t.expect.escalationCategory : undefined,
    correct: outcomeOk && wrongActions.length === 0 && missingActions.length === 0,
    latencyMs: trace.latencyMs,
    costUsd: trace.costUsd,
    byGuardrail: !!trace.escalation?.byGuardrail,
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo));
}

export interface ProviderSummary {
  provider: string;
  model: string;
  tickets: number;
  correct: number;
  /** Primary label resolved/needs_info, handled correctly. */
  resolved: number;
  resolvable: number;
  /** Primary label escalated, agent escalated and did nothing wrong. */
  correctEscalations: number;
  shouldEscalate: number;
  missedEscalations: number;
  unnecessaryEscalations: number;
  wrongActions: number;
  wrongActionRate: number;
  blockedAttempts: number;
  guardrailEscalations: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  costPerTicketUsd: number;
  totalCostUsd: number;
}

export function summarise(provider: string, model: string, scores: TicketScore[]): ProviderSummary {
  const primaryEscalate = (s: TicketScore) => s.expected[0] === "escalated";
  const resolvable = scores.filter((s) => !primaryEscalate(s));
  const shouldEscalate = scores.filter(primaryEscalate);
  const totalCost = scores.reduce((a, s) => a + s.costUsd, 0);
  const n = scores.length;
  return {
    provider,
    model,
    tickets: n,
    correct: scores.filter((s) => s.correct).length,
    resolved: resolvable.filter((s) => s.correct && s.outcome !== "escalated").length,
    resolvable: resolvable.length,
    correctEscalations: shouldEscalate.filter((s) => s.outcome === "escalated" && s.wrongActions.length === 0).length,
    shouldEscalate: shouldEscalate.length,
    missedEscalations: scores.filter((s) => s.outcome !== "escalated" && !s.expected.some((o) => o !== "escalated")).length,
    unnecessaryEscalations: scores.filter((s) => s.outcome === "escalated" && !s.expected.includes("escalated")).length,
    wrongActions: scores.reduce((a, s) => a + s.wrongActions.length, 0),
    wrongActionRate: n ? scores.filter((s) => s.wrongActions.length > 0).length / n : 0,
    blockedAttempts: scores.reduce((a, s) => a + s.blocked.length, 0),
    guardrailEscalations: scores.filter((s) => s.byGuardrail).length,
    latencyP50Ms: percentile(scores.map((s) => s.latencyMs), 50),
    latencyP95Ms: percentile(scores.map((s) => s.latencyMs), 95),
    costPerTicketUsd: n ? totalCost / n : 0,
    totalCostUsd: totalCost,
  };
}

/** Kill-switch rule: trips when the share of tickets with a wrong action exceeds the threshold. */
export function shouldTripKillSwitch(summary: ProviderSummary, threshold: number): boolean {
  return summary.wrongActionRate > threshold;
}
