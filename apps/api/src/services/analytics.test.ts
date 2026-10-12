import { describe, expect, it, vi } from "vitest";
import { PaymentStatus, type DatabaseClient } from "@mandatepay/database";
import { capturedPaymentStatuses, dashboardSummary, reversedRemainderMinor } from "./analytics.js";

describe("captured volume with PayPal reversals", () => {
  it("counts a reversed payment as captured", () => {
    expect(capturedPaymentStatuses).toEqual([
      PaymentStatus.COMPLETED,
      PaymentStatus.PARTIALLY_REFUNDED,
      PaymentStatus.REFUNDED,
      PaymentStatus.REVERSED,
    ]);
  });

  it("subtracts only the part of a reversal not already refunded", () => {
    expect(reversedRemainderMinor([])).toBe(0n);
    expect(
      reversedRemainderMinor([
        { amount: 13_900n, refunds: [] },
        { amount: 16_900n, refunds: [{ amount: 4_000n }] },
        // Fully refunded before the chargeback: nothing more was returned.
        { amount: 5_000n, refunds: [{ amount: 5_000n }] },
      ]),
    ).toBe(13_900n + 12_900n);
  });

  it("reports reversed volume beside refunds in the owned summary", async () => {
    const aggregate = vi.fn(async () => ({ _count: { _all: 3 }, _sum: { amount: 40_000n } }));
    const findMany = vi.fn(async () => [{ amount: 13_900n, refunds: [{ amount: 900n }] }]);
    const database = {
      $queryRaw: vi.fn(async () => [{ decision: "ALLOW", count: 3n }]),
      payment: { aggregate, findMany },
      refund: { aggregate: vi.fn(async () => ({ _sum: { amount: 2_500n } })) },
      approval: { count: vi.fn(async () => 1) },
      mandate: { count: vi.fn(async () => 2) },
    } as unknown as DatabaseClient;

    const summary = await dashboardSummary(database, { id: "user-1" });
    expect(summary.totals).toEqual({
      purchases: 3,
      policyAllowed: 3,
      humanApproved: 1,
      blocked: 0,
      spendMinor: 40_000,
      refundsMinor: 2_500,
      reversedMinor: 13_000,
      activeMandates: 2,
    });
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          status: { in: capturedPaymentStatuses },
        }),
      }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", status: PaymentStatus.REVERSED }),
      }),
    );
  });
});
