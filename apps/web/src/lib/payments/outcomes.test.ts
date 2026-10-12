import { describe, expect, it } from "vitest";
import { paymentOutcomeNotice } from "./outcomes";
import type { PaymentRecord } from "./types";

const base: PaymentRecord = {
  id: "payment_1",
  proposalId: "proposal_1",
  status: "APPROVED",
  amount: 13_900,
  currency: "USD",
  paypalOrderId: "ORDER-1",
  paypalCaptureId: null,
  capturedAt: null,
  createdAt: "2026-10-02T12:00:00Z",
  product: { title: "Demo", brand: "Demo", condition: "NEW", merchant: "Demo Store" },
  mandate: { title: "Headphones", version: 1 },
  refunds: [],
};

describe("payment outcome notices", () => {
  it("asks the payer to choose another funding source after INSTRUMENT_DECLINED", () => {
    const notice = paymentOutcomeNotice({
      ...base,
      providerStatusReason: "INSTRUMENT_DECLINED",
      payerActionUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1",
    });
    expect(notice).toMatchObject({
      tone: "error",
      payerActionRequired: true,
      actionUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1",
      actionLabel: "Choose another payment method",
    });
    expect(notice?.message).toContain("No money was taken");
  });

  it("explains declined, voided, denied and reversed payments without provider text", () => {
    expect(
      paymentOutcomeNotice({
        ...base,
        status: "FAILED",
        failureCode: "PAYPAL_CAPTURE_REJECTED:TRANSACTION_REFUSED",
      })?.message,
    ).toContain("spending hold was released");
    expect(
      paymentOutcomeNotice({ ...base, status: "FAILED", failureCode: "PAYPAL_ORDER_VOIDED" })
        ?.message,
    ).toContain("voided");
    expect(paymentOutcomeNotice({ ...base, status: "DENIED" })?.tone).toBe("error");
    expect(paymentOutcomeNotice({ ...base, status: "REVERSED" })?.message).toContain("reversed");
  });

  it("describes held, unconfirmed and unapproved states", () => {
    expect(
      paymentOutcomeNotice({
        ...base,
        status: "CAPTURE_PENDING",
        providerStatusReason: "PENDING_REVIEW",
      })?.message,
    ).toContain("pending review");
    expect(
      paymentOutcomeNotice({ ...base, providerStatusReason: "CAPTURE_NOT_CONFIRMED" }),
    ).toMatchObject({ tone: "info", payerActionRequired: false });
    expect(
      paymentOutcomeNotice({
        ...base,
        status: "CREATED",
        providerStatusReason: "ORDER_NOT_APPROVED",
        payerActionUrl: null,
      }),
    ).toMatchObject({ payerActionRequired: true, actionUrl: null, actionLabel: null });
    expect(paymentOutcomeNotice(base)).toBeNull();
    expect(paymentOutcomeNotice({ ...base, status: "COMPLETED" })).toBeNull();
  });
});
