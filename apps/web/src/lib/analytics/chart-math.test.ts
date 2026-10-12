import { describe, expect, it } from "vitest";
import {
  capturedSpendByCategory,
  decisionCounts,
  isCapturedRow,
  paymentStatusLabel,
  refundStatusLabel,
} from "./chart-math";
import type { TransactionRow } from "./types";

const row = (overrides: Partial<TransactionRow>): TransactionRow => ({
  id: "row",
  paymentId: "payment-1",
  createdAt: "2026-10-02T12:00:00Z",
  capturedAt: "2026-10-03T12:00:00Z",
  activityAt: "2026-10-03T12:00:00Z",
  product: { title: "Product", brand: "Brand", condition: "NEW" },
  merchant: "Merchant",
  category: "Office",
  amountMinor: 10_000,
  currency: "USD",
  mandate: { title: "Mandate", version: 1 },
  decision: "ALLOW",
  approvalType: "AUTO_APPROVED",
  paypalStatus: "COMPLETED",
  ...overrides,
});

describe("analytics chart math", () => {
  it("counts captured spend only, never proposal-only rows", () => {
    expect(
      capturedSpendByCategory([
        row({ amountMinor: 10_000, category: "Office", paypalStatus: "COMPLETED" }),
        row({
          id: "proposal-only",
          amountMinor: 99_000,
          category: "Electronics",
          paypalStatus: null,
        }),
        row({ id: "refunded", amountMinor: 2_000, category: "Office", paypalStatus: "REFUNDED" }),
      ]),
    ).toEqual([{ label: "Office", amountMinor: 12_000 }]);
  });

  it("keeps a PayPal-reversed payment in gross captured spend", () => {
    expect(
      capturedSpendByCategory([
        row({ amountMinor: 10_000, category: "Headphones", paypalStatus: "COMPLETED" }),
        row({
          id: "reversed",
          amountMinor: 16_900,
          category: "Headphones",
          paypalStatus: "REVERSED",
        }),
        row({
          id: "pending",
          amountMinor: 5_000,
          category: "Headphones",
          paypalStatus: "CAPTURE_PENDING",
        }),
      ]),
    ).toEqual([{ label: "Headphones", amountMinor: 26_900 }]);
    expect(isCapturedRow({ capturedAt: "2026-10-03T12:00:00Z", paypalStatus: "REVERSED" })).toBe(
      true,
    );
    expect(isCapturedRow({ capturedAt: null, paypalStatus: "REVERSED" })).toBe(false);
    expect(isCapturedRow({ capturedAt: "2026-10-03T12:00:00Z", paypalStatus: "DENIED" })).toBe(
      false,
    );
  });

  it("labels refunds and reversals for the transaction table", () => {
    expect(refundStatusLabel("REFUNDED")).toBe("Refunded");
    expect(refundStatusLabel("PARTIALLY_REFUNDED")).toBe("Partial refund");
    expect(refundStatusLabel("REVERSED")).toBe("Reversed by PayPal");
    expect(refundStatusLabel("COMPLETED")).toBe("—");
    expect(refundStatusLabel(null)).toBe("—");
    expect(paymentStatusLabel("REVERSED")).toBe("Reversed by PayPal");
    expect(paymentStatusLabel("CAPTURE_PENDING")).toBe("CAPTURE PENDING");
    expect(paymentStatusLabel(null)).toBe("Not recorded");
  });

  it("groups decisions without inventing missing values", () => {
    expect(
      decisionCounts([
        row({ decision: "BLOCK" }),
        row({ id: "two", decision: "BLOCK" }),
        row({ id: "three", decision: null }),
      ]),
    ).toEqual([
      { label: "BLOCK", count: 2 },
      { label: "UNDECIDED", count: 1 },
    ]);
  });
});
