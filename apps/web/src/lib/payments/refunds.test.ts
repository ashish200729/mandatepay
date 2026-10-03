import { describe, expect, it } from "vitest";
import { calculateRemainingRefundableMinor, calculateRefundedMinor } from "./refunds";
import type { PaymentRefund } from "./types";

const refund = (status: string, amount: number): PaymentRefund => ({
  id: `${status}-${amount}`,
  status,
  amount,
  currency: "USD",
  paypalRefundId: null,
});

describe("refund remaining arithmetic", () => {
  it("counts submitted and completed refund amounts against the remaining cap", () => {
    const refunds = [
      refund("REQUESTED", 1_000),
      refund("SUBMITTED", 2_000),
      refund("FAILED", 9_000),
      refund("COMPLETED", 500),
    ];
    expect(calculateRefundedMinor(refunds)).toBe(3_500);
    expect(calculateRemainingRefundableMinor(10_000, refunds)).toBe(6_500);
  });

  it("never exposes a negative refundable amount", () => {
    expect(calculateRemainingRefundableMinor(1_000, [refund("COMPLETED", 2_000)])).toBe(0);
  });
});
