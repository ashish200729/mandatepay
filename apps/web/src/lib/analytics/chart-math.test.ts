import { describe, expect, it } from "vitest";
import { capturedSpendByCategory, decisionCounts } from "./chart-math";
import type { TransactionRow } from "./types";

const row = (overrides: Partial<TransactionRow>): TransactionRow => ({
  id: "row",
  createdAt: "2026-10-02T12:00:00Z",
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
