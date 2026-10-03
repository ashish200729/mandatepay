import { describe, expect, it } from "vitest";
import { evaluateRefund, evaluateRefundPolicy } from "../src/index.js";

const base = {
  ownsPayment: true,
  paymentStatus: "COMPLETED" as const,
  paymentCurrency: "USD" as const,
  requestedCurrency: "USD" as const,
  capturedAmount: 10_000,
  alreadyRefundedAmount: 0,
  requestedAmount: 5_000,
  explicitConfirmation: true,
};

describe("AgentGuard deterministic refund policy", () => {
  it("allows an owned confirmed refund within the remaining capture", () => {
    expect(evaluateRefundPolicy(base)).toEqual({ decision: "ALLOW", reasonCodes: [] });
  });

  it("blocks ownership, currency, confirmation, and amount violations", () => {
    const decision = evaluateRefund({
      ...base,
      ownsPayment: false,
      requestedCurrency: "USD",
      requestedAmount: 10_001,
      alreadyRefundedAmount: 2_000,
      explicitConfirmation: false,
    });
    expect(decision.decision).toBe("BLOCK");
    expect(decision.reasonCodes).toEqual(
      expect.arrayContaining([
        "REFUND_NOT_OWNED",
        "REFUND_EXCEEDS_REMAINING",
        "REFUND_CONFIRMATION_REQUIRED",
      ]),
    );
  });

  it("fails closed for malformed contexts", () => {
    expect(evaluateRefund({})).toEqual({
      decision: "BLOCK",
      reasonCodes: ["INVALID_REFUND_POLICY_INPUT"],
    });
  });
});
