import { describe, expect, it } from "vitest";
import { isSafeSandboxApprovalUrl, readPayment } from "./client";

describe("PayPal Sandbox client guards", () => {
  it("accepts only official HTTPS Sandbox approval hosts", () => {
    expect(isSafeSandboxApprovalUrl("https://www.sandbox.paypal.com/checkoutnow?token=abc")).toBe(
      true,
    );
    expect(isSafeSandboxApprovalUrl("https://sandbox.paypal.com/checkoutnow?token=abc")).toBe(true);
    expect(isSafeSandboxApprovalUrl("https://paypal.com/checkoutnow?token=abc")).toBe(false);
    expect(isSafeSandboxApprovalUrl("http://www.sandbox.paypal.com/checkoutnow")).toBe(false);
    expect(isSafeSandboxApprovalUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects malformed payment DTOs and accepts null provider identifiers", () => {
    expect(() => readPayment({ payment: { id: "payment_1" } })).toThrow();
    expect(
      readPayment({
        payment: {
          id: "payment_1",
          proposalId: "proposal_1",
          status: "PAYPAL_ORDER_CREATED",
          amount: 16_900,
          currency: "USD",
          paypalOrderId: "order_1",
          paypalCaptureId: null,
          capturedAt: null,
          createdAt: "2026-10-02T12:00:00Z",
          product: {
            title: "Demo headphones",
            brand: "Demo",
            condition: "NEW",
            merchant: "Demo Store",
          },
          mandate: { title: "Headphones", version: 1 },
          refunds: [],
        },
      }),
    ).toMatchObject({ paypalCaptureId: null, amount: 16_900 });
  });
});
