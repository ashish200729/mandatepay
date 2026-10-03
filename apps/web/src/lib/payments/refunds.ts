import type { PaymentRefund } from "./types";

export const REFUND_ACCOUNTED_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "SUBMITTED",
  "COMPLETED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
] as const;

export function calculateRefundedMinor(refunds: readonly PaymentRefund[]) {
  return refunds
    .filter((refund) =>
      REFUND_ACCOUNTED_STATUSES.includes(
        refund.status as (typeof REFUND_ACCOUNTED_STATUSES)[number],
      ),
    )
    .reduce((total, refund) => total + refund.amount, 0);
}

export function calculateRemainingRefundableMinor(
  amount: number,
  refunds: readonly PaymentRefund[],
) {
  return Math.max(0, amount - calculateRefundedMinor(refunds));
}
