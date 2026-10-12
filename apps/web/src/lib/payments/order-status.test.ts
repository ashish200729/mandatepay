import { describe, expect, it } from "vitest";
import { orderStatusLabel, orderStatusPresentation } from "./order-status";
import type { PaymentRefund } from "./types";

function refund(overrides: Partial<PaymentRefund> = {}): PaymentRefund {
  return {
    id: "refund-1",
    status: "COMPLETED",
    amount: 1_000,
    currency: "USD",
    paypalRefundId: "PP-REFUND-1",
    ...overrides,
  };
}

describe("order status presentation", () => {
  it("explains a PayPal reversal", () => {
    expect(orderStatusPresentation({ status: "REVERSED", refunds: [] })).toEqual({
      label: "Reversed by PayPal",
      tone: "danger",
      note: "PayPal reversed this payment, for example after a dispute or chargeback.",
    });
  });

  it("labels refunds issued in the PayPal dashboard", () => {
    expect(
      orderStatusPresentation({
        status: "REFUNDED",
        refunds: [refund({ providerInitiated: true })],
      }),
    ).toMatchObject({ label: "Refunded in PayPal", note: expect.stringContaining("outside") });
    expect(
      orderStatusPresentation({
        status: "PARTIALLY_REFUNDED",
        refunds: [refund({ providerInitiated: true })],
      }).label,
    ).toBe("Partially refunded in PayPal");
  });

  it("keeps the plain label when any completed refund came from MandatePay", () => {
    expect(
      orderStatusPresentation({
        status: "REFUNDED",
        refunds: [refund({ providerInitiated: true }), refund({ id: "refund-2" })],
      }),
    ).toEqual({ label: "Refunded", tone: "neutral", note: null });
    // A failed provider refund does not relabel a MandatePay refund.
    expect(
      orderStatusPresentation({
        status: "REFUNDED",
        refunds: [refund(), refund({ id: "x", status: "FAILED", providerInitiated: true })],
      }).label,
    ).toBe("Refunded");
  });

  it("labels every payment status readably", () => {
    expect(orderStatusPresentation({ status: "COMPLETED", refunds: [] }).label).toBe("Paid");
    expect(orderStatusPresentation({ status: "CAPTURE_PENDING", refunds: [] })).toMatchObject({
      label: "Payment pending",
      tone: "attention",
    });
    expect(orderStatusPresentation({ status: "DENIED", refunds: [] }).tone).toBe("danger");
    expect(orderStatusLabel("SOMETHING_NEW")).toBe("Something new");
    expect(orderStatusLabel("")).toBe("Unknown");
  });
});
