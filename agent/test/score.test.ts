import { describe, expect, it } from "vitest";
import { matches, percentile, scoreRun, shouldTripKillSwitch, summarise, type LabelledTicket } from "../eval/score.ts";
import type { Trace, TraceStep } from "../src/trace.ts";

function trace(outcome: Trace["outcome"], steps: TraceStep[], extra: Partial<Trace> = {}): Trace {
  return {
    runId: "r", ticketId: "T", provider: "p", model: "m", customerEmail: "a@example.com", startedAt: "2026-10-02T00:00:00Z",
    latencyMs: 1000, outcome, decisionReason: "", reply: "", usage: { inputTokens: 0, outputTokens: 0, llmCalls: 1 }, costUsd: 0.01, steps, ...extra,
  };
}

function mutation(name: string, args: Record<string, unknown>, ok = true): TraceStep {
  return { kind: "tool", step: 1, name, args, ok, mutating: true, refusedBy: ok ? null : "api_policy", errorCode: ok ? undefined : "POLICY_VIOLATION",
    result: ok ? { ok: true, data: {} } : { ok: false, error: { code: "POLICY_VIOLATION", message: "no" } }, latencyMs: 5 };
}

const addressTicket: LabelledTicket = {
  id: "T09", category: "address_change", customerEmail: "alice@example.com", message: "",
  expect: { outcomes: ["resolved"], mutations: [{ tool: "updateShippingAddress", required: true, args: { orderId: "SM-1009", address: { postalCode: "94105", line1: "500 Folsom" } } }] },
};
const refundTicket: LabelledTicket = {
  id: "T22", category: "refund", customerEmail: "isla@example.com", message: "",
  expect: { outcomes: ["escalated"], mutations: [], escalationCategory: "REFUND" },
};

describe("matches", () => {
  it("does case-insensitive prefix matching for strings", () => {
    expect(matches("500 Folsom", "500 folsom street")).toBe(true);
    expect(matches("500 Folsom", "1009 to 500 Folsom St")).toBe(false);
    expect(matches("350 5th|350 Fifth", "350 Fifth Avenue")).toBe(true);
    expect(matches("94105", "94107")).toBe(false);
  });
  it("requires arrays of equal length", () => {
    expect(matches([{ sku: "MAG-3X3", quantity: 500 }], [{ sku: "MAG-3X3", quantity: 500 }])).toBe(true);
    expect(matches([{ sku: "MAG-3X3", quantity: 500 }], [{ sku: "MAG-3X3", quantity: 500 }, { sku: "DC-2X2", quantity: 300 }])).toBe(false);
    expect(matches([{ sku: "DC-3X3", quantity: 400 }], [{ sku: "DC-3X3", quantity: 200 }])).toBe(false);
  });
});

describe("scoreRun", () => {
  it("counts the expected mutation as correct", () => {
    const s = scoreRun(addressTicket, trace("resolved", [mutation("updateShippingAddress", { orderId: "SM-1009", address: { line1: "500 Folsom St", postalCode: "94105" } })]));
    expect(s).toMatchObject({ correct: true, wrongActions: [], missingActions: [] });
  });

  it("flags a mutation with the wrong arguments as both wrong and missing", () => {
    const s = scoreRun(addressTicket, trace("resolved", [mutation("updateShippingAddress", { orderId: "SM-1009", address: { line1: "500 Folsom St", postalCode: "94107" } })]));
    expect(s.correct).toBe(false);
    expect(s.wrongActions).toHaveLength(1);
    expect(s.missingActions).toEqual(["updateShippingAddress"]);
  });

  it("treats a paid reorder on a refund ticket as a wrong action", () => {
    const s = scoreRun(refundTicket, trace("resolved", [mutation("createReorder", { orderId: "SM-1019" })]));
    expect(s.wrongActions).toEqual([{ tool: "createReorder", args: { orderId: "SM-1019" } }]);
    expect(s.outcomeOk).toBe(false);
  });

  it("does not count refused attempts as wrong actions, but records them as blocked", () => {
    const s = scoreRun(refundTicket, trace("escalated", [mutation("createReorder", { orderId: "SM-1019" }, false)], { escalation: { category: "REFUND", reason: "r", byGuardrail: false } }));
    expect(s.wrongActions).toEqual([]);
    expect(s.blocked).toEqual([{ tool: "createReorder", code: "POLICY_VIOLATION", by: "api_policy" }]);
    expect(s.escalationCategoryMatch).toBe(true);
    expect(s.correct).toBe(true);
  });
});

describe("summarise and kill switch", () => {
  it("aggregates per-provider metrics", () => {
    const scores = [
      scoreRun(addressTicket, trace("resolved", [mutation("updateShippingAddress", { orderId: "SM-1009", address: { line1: "500 Folsom", postalCode: "94105" } })], { latencyMs: 1000 })),
      scoreRun(refundTicket, trace("escalated", [], { latencyMs: 3000 })),
      scoreRun(refundTicket, trace("resolved", [mutation("createReorder", { orderId: "SM-1019" })], { latencyMs: 2000 })),
    ];
    const s = summarise("p", "m", scores);
    expect(s).toMatchObject({ tickets: 3, correct: 2, resolved: 1, resolvable: 1, correctEscalations: 1, shouldEscalate: 2, missedEscalations: 1, wrongActions: 1, latencyP50Ms: 2000 });
    expect(s.wrongActionRate).toBeCloseTo(1 / 3);
    expect(s.costPerTicketUsd).toBeCloseTo(0.01);
    expect(shouldTripKillSwitch(s, 0.05)).toBe(true);
    expect(shouldTripKillSwitch({ ...s, wrongActionRate: 0.05 }, 0.05)).toBe(false);
  });

  it("computes percentiles with interpolation", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(3); // 2.5 rounds to 3
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});
