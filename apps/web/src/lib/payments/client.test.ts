import { describe, expect, it } from "vitest";
import { isSafePayPalApprovalUrl, readPayment } from "./client";

describe("PayPal client guards", () => {
  it("accepts exactly the HTTPS Sandbox and live checkout hosts", () => {
    expect(isSafePayPalApprovalUrl("https://www.sandbox.paypal.com/checkoutnow?token=abc")).toBe(
      true,
    );
    expect(isSafePayPalApprovalUrl("https://www.paypal.com/checkoutnow?token=abc")).toBe(true);
    expect(isSafePayPalApprovalUrl("https://sandbox.paypal.com/checkoutnow?token=abc")).toBe(false);
    expect(isSafePayPalApprovalUrl("https://paypal.com/checkoutnow?token=abc")).toBe(false);
    expect(isSafePayPalApprovalUrl("https://www.paypal.com.evil.example/checkoutnow")).toBe(false);
    expect(isSafePayPalApprovalUrl("https://www.paypal.com:8443/checkoutnow")).toBe(false);
    expect(isSafePayPalApprovalUrl("https://user@www.paypal.com/checkoutnow")).toBe(false);
    expect(isSafePayPalApprovalUrl("http://www.sandbox.paypal.com/checkoutnow")).toBe(false);
    expect(isSafePayPalApprovalUrl("javascript:alert(1)")).toBe(false);
  });

  it("keeps only safe outcome fields and drops an unsafe payer-action URL", () => {
    const base = {
      id: "payment_1",
      proposalId: "proposal_1",
      status: "APPROVED",
      amount: 16_900,
      currency: "USD",
      paypalOrderId: "order_1",
      paypalCaptureId: null,
      capturedAt: null,
      createdAt: "2026-10-02T12:00:00Z",
      product: { title: "Demo", brand: "Demo", condition: "NEW", merchant: "Demo Store" },
      mandate: { title: "Headphones", version: 1 },
      refunds: [],
    };
    expect(
      readPayment({
        payment: {
          ...base,
          providerStatusReason: "INSTRUMENT_DECLINED",
          payerActionUrl: "https://www.sandbox.paypal.com/checkoutnow?token=order_1",
        },
      }),
    ).toMatchObject({
      providerStatusReason: "INSTRUMENT_DECLINED",
      payerActionUrl: "https://www.sandbox.paypal.com/checkoutnow?token=order_1",
    });
    expect(
      readPayment({
        payment: {
          ...base,
          providerStatusReason: "<script>",
          payerActionUrl: "https://attacker.example/checkoutnow",
        },
      }),
    ).toMatchObject({ providerStatusReason: null, payerActionUrl: null });
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
