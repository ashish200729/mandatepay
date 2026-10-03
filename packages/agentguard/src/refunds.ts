import { CurrencyCodeSchema, minorUnitsSchema, type MinorUnits } from "@mandatepay/shared";
import { z } from "zod";

export const REFUND_REASON_CODES = [
  "INVALID_REFUND_POLICY_INPUT",
  "REFUND_NOT_OWNED",
  "PAYMENT_NOT_REFUNDABLE",
  "REFUND_CURRENCY_MISMATCH",
  "REFUND_AMOUNT_INVALID",
  "REFUND_EXCEEDS_REMAINING",
  "REFUND_CONFIRMATION_REQUIRED",
] as const;

export const RefundReasonCodeSchema = z.enum(REFUND_REASON_CODES);
export type RefundReasonCode = z.infer<typeof RefundReasonCodeSchema>;

export const RefundPolicyContextSchema = z
  .object({
    ownsPayment: z.boolean(),
    paymentStatus: z.enum(["COMPLETED", "PARTIALLY_REFUNDED"]),
    paymentCurrency: CurrencyCodeSchema,
    requestedCurrency: CurrencyCodeSchema,
    capturedAmount: minorUnitsSchema,
    alreadyRefundedAmount: minorUnitsSchema,
    requestedAmount: minorUnitsSchema,
    explicitConfirmation: z.boolean(),
  })
  .strict();

export type RefundPolicyContext = z.output<typeof RefundPolicyContextSchema>;

export interface RefundPolicyDecision {
  readonly decision: "ALLOW" | "BLOCK";
  readonly reasonCodes: readonly RefundReasonCode[];
}

function blocked(reasonCodes: readonly RefundReasonCode[]): RefundPolicyDecision {
  return Object.freeze({
    decision: "BLOCK" as const,
    reasonCodes: Object.freeze([...reasonCodes]),
  });
}

function allowed(): RefundPolicyDecision {
  return Object.freeze({ decision: "ALLOW" as const, reasonCodes: Object.freeze([]) });
}

export function evaluateRefundPolicy(input: RefundPolicyContext): RefundPolicyDecision {
  const reasons: RefundReasonCode[] = [];
  if (!input.ownsPayment) reasons.push("REFUND_NOT_OWNED");
  if (input.paymentStatus !== "COMPLETED" && input.paymentStatus !== "PARTIALLY_REFUNDED") {
    reasons.push("PAYMENT_NOT_REFUNDABLE");
  }
  if (input.paymentCurrency !== input.requestedCurrency) {
    reasons.push("REFUND_CURRENCY_MISMATCH");
  }
  if (input.requestedAmount <= 0) reasons.push("REFUND_AMOUNT_INVALID");
  if (input.alreadyRefundedAmount < 0 || input.alreadyRefundedAmount > input.capturedAmount) {
    reasons.push("REFUND_AMOUNT_INVALID");
  } else if (input.requestedAmount > input.capturedAmount - input.alreadyRefundedAmount) {
    reasons.push("REFUND_EXCEEDS_REMAINING");
  }
  if (!input.explicitConfirmation) reasons.push("REFUND_CONFIRMATION_REQUIRED");
  return reasons.length > 0 ? blocked(reasons) : allowed();
}

export function evaluateRefund(input: unknown): RefundPolicyDecision {
  const parsed = RefundPolicyContextSchema.safeParse(input);
  if (!parsed.success) return blocked(["INVALID_REFUND_POLICY_INPUT"]);
  return evaluateRefundPolicy(parsed.data);
}

export type RefundMinorUnits = MinorUnits;
