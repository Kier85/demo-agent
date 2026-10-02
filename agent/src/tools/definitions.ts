import { z } from "zod";
import type { ToolSpec } from "../providers/types.ts";

// One zod schema per tool is the single source of truth: it is converted to
// JSON Schema for the model and used to validate whatever the model sends back.
// Every tool takes a `reason` so each step in the trace says *why* it happened.
// Customer identity and ticket id are NOT parameters: plain code injects them,
// so the model cannot act on another customer's behalf.

const reason = z.string().min(3).describe("One sentence: why you are taking this step.");
const orderId = z.string().regex(/^SM-\d{4}$/, "order ids look like SM-1234").describe("Order id, e.g. SM-1001");

export const schemas = {
  getOrder: z.object({ orderId, reason }),
  getShipment: z.object({ orderId, reason }),
  updateShippingAddress: z.object({
    orderId,
    address: z.object({
      name: z.string().min(1),
      line1: z.string().min(1),
      line2: z.string().optional(),
      city: z.string().min(1),
      region: z.string().optional().describe("State / province code"),
      postalCode: z.string().min(1),
      country: z.string().length(2).describe("ISO 3166 alpha-2, e.g. US"),
    }),
    reason,
  }),
  createReorder: z.object({
    orderId,
    items: z
      .array(z.object({ sku: z.string().min(1), quantity: z.number().int() }))
      .optional()
      .describe("Lines to reorder. Omit to copy the whole original order at the original quantities."),
    reason,
  }),
  escalateToHuman: z.object({
    category: z.enum(["REFUND", "DAMAGED_OR_MISPRINT", "LOST_OR_DELAYED", "POLICY_EXCEPTION", "AMBIGUOUS", "OTHER"]),
    orderId: orderId.optional(),
    reason: z.string().min(10).describe("Why a human must handle this. Be specific."),
    summary: z.string().min(1).describe("Short handoff note for the human agent: what the customer wants and what you found."),
  }),
  respondToCustomer: z.object({
    message: z.string().min(1).describe("The reply sent to the customer."),
    outcome: z
      .enum(["resolved", "needs_info"])
      .describe("resolved = the request is fully handled; needs_info = you asked the customer for missing details."),
    reason,
  }),
} as const;

export type ToolName = keyof typeof schemas;
export type ToolArgs<T extends ToolName> = z.infer<(typeof schemas)[T]>;

export const MUTATING_TOOLS: ReadonlySet<ToolName> = new Set(["updateShippingAddress", "createReorder"]);
export const TERMINAL_TOOL: ToolName = "respondToCustomer";

const descriptions: Record<ToolName, string> = {
  getOrder:
    "Look up an order of the current customer: status, items (sku, quantity), shipping address and whether the address can still be changed. Returns NOT_FOUND for orders that don't exist or belong to someone else.",
  getShipment:
    "Live carrier tracking for an order: status (LABEL_CREATED, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, EXCEPTION), estimated delivery and tracking events. Returns null data if the order has not shipped.",
  updateShippingAddress:
    "Change the shipping address of an order. Only allowed before production (status RECEIVED or PROOF_PENDING); the backend refuses otherwise. Requires a complete address.",
  createReorder:
    "Create a new order that repeats items from a past order. The customer pays for it as a normal order (it starts at RECEIVED and goes through proof approval). Not for free replacements: damaged or misprinted goods must be escalated.",
  escalateToHuman:
    "Hand the ticket to a human support agent. Use for refunds, credits, damaged/misprinted goods, lost or late shipments, policy exceptions, threats, and anything you are not sure about. After escalating you cannot make further changes.",
  respondToCustomer:
    "Send the final reply to the customer and end the ticket. Always call this exactly once, last.",
};

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export const toolSpecs: ToolSpec[] = (Object.keys(schemas) as ToolName[]).map((name) => ({
  name,
  description: descriptions[name],
  parameters: toJsonSchema(schemas[name]),
}));

export function isToolName(v: string): v is ToolName {
  return Object.hasOwn(schemas, v);
}
