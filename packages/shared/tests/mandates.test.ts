import { describe, expect, it } from "vitest";
import {
  CanonicalMandateSchema,
  ProductConditionSchema,
  PurchaseProposalSchema,
  RefundRequestSchema,
  parseDecimalToMinorUnits,
} from "../src/index.js";

const validMandate = () => ({
  title: "Headphones",
  productIntent: "Noise-cancelling headphones",
  currency: "USD",
  timezone: "UTC",
  allowedBrands: ["Sony", "Bose"],
  blockedBrands: [],
  allowedCategories: ["headphones"],
  blockedCategories: [],
  allowedConditions: ["NEW"],
  autoSpendLimit: parseDecimalToMinorUnits("150"),
  transactionLimit: parseDecimalToMinorUnits("180"),
  dailyLimit: parseDecimalToMinorUnits("200"),
  weeklyLimit: parseDecimalToMinorUnits("500"),
  monthlyLimit: parseDecimalToMinorUnits("1000"),
  quantityLimit: 1,
  allowedMerchants: ["Demo Merchant"],
  blockedMerchants: [],
  newMerchantRequiresApproval: true,
  startsAt: "2026-10-02T00:00:00Z",
  expiresAt: "2026-10-03T00:00:00Z",
});

describe("canonical mandate contracts", () => {
  it("accepts the reviewed USD mandate shape", () => {
    const result = CanonicalMandateSchema.safeParse(validMandate());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autoSpendLimit).toBe(15000);
      expect(result.data.timezone).toBe("UTC");
      expect(result.data.quantityLimit).toBe(1);
    }
  });

  it("requires automatic spending to stay within the transaction limit", () => {
    const result = CanonicalMandateSchema.safeParse({
      ...validMandate(),
      autoSpendLimit: parseDecimalToMinorUnits("181"),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "autoSpendLimit")).toBe(
        true,
      );
    }
  });

  it("rejects zero optional limits, zero transaction limits, and zero quantity", () => {
    for (const override of [
      { dailyLimit: 0 },
      { weeklyLimit: 0 },
      { monthlyLimit: 0 },
      { transactionLimit: 0 },
      { quantityLimit: 0 },
    ]) {
      expect(CanonicalMandateSchema.safeParse({ ...validMandate(), ...override }).success).toBe(
        false,
      );
    }
  });

  it("rejects invalid currency, non-UTC timezone, offset dates, and untrusted number strings", () => {
    expect(CanonicalMandateSchema.safeParse({ ...validMandate(), currency: "EUR" }).success).toBe(
      false,
    );
    expect(
      CanonicalMandateSchema.safeParse({ ...validMandate(), timezone: "Asia/Kolkata" }).success,
    ).toBe(false);
    expect(
      CanonicalMandateSchema.safeParse({
        ...validMandate(),
        startsAt: "2026-10-02T00:00:00+05:30",
      }).success,
    ).toBe(false);
    expect(
      CanonicalMandateSchema.safeParse({
        ...validMandate(),
        transactionLimit: "180",
      }).success,
    ).toBe(false);
  });

  it("rejects arbitrary AI permissions and contradictory allow/block lists", () => {
    expect(
      CanonicalMandateSchema.safeParse({ ...validMandate(), spendWhatever: true }).success,
    ).toBe(false);
    expect(
      CanonicalMandateSchema.safeParse({
        ...validMandate(),
        allowedBrands: ["Sony"],
        blockedBrands: ["sony"],
      }).success,
    ).toBe(false);
  });

  it("requires a chronological UTC window and an explicit new-merchant approval rule", () => {
    expect(
      CanonicalMandateSchema.safeParse({
        ...validMandate(),
        startsAt: "2026-10-04T00:00:00Z",
        expiresAt: "2026-10-03T00:00:00Z",
      }).success,
    ).toBe(false);
    const withoutMerchantRule = Object.fromEntries(
      Object.entries(validMandate()).filter(([key]) => key !== "newMerchantRequiresApproval"),
    );
    expect(CanonicalMandateSchema.safeParse(withoutMerchantRule).success).toBe(false);
  });

  it("validates condition values and server-computed proposal totals", () => {
    expect(ProductConditionSchema.safeParse("REFURBISHED").success).toBe(true);
    expect(ProductConditionSchema.safeParse("OPEN_BOX").success).toBe(false);

    const proposal = PurchaseProposalSchema.safeParse({
      mandateId: "mandate_1",
      productSnapshotId: "snapshot_1",
      quantity: 1,
      subtotal: parseDecimalToMinorUnits("150"),
      shipping: parseDecimalToMinorUnits("5"),
      tax: parseDecimalToMinorUnits("10"),
      total: parseDecimalToMinorUnits("165"),
      currency: "USD",
      idempotencyKey: "proposal_1",
    });

    expect(proposal.success).toBe(true);
    expect(
      PurchaseProposalSchema.safeParse({
        mandateId: "mandate_1",
        productSnapshotId: "snapshot_1",
        quantity: 1,
        subtotal: parseDecimalToMinorUnits("150"),
        shipping: parseDecimalToMinorUnits("5"),
        tax: parseDecimalToMinorUnits("10"),
        total: parseDecimalToMinorUnits("164"),
        currency: "USD",
        idempotencyKey: "proposal_1",
      }).success,
    ).toBe(false);
    expect(
      PurchaseProposalSchema.safeParse({
        mandateId: "mandate_1",
        productSnapshotId: "snapshot_1",
        quantity: 1,
        subtotal: "150.00",
        shipping: parseDecimalToMinorUnits("5"),
        tax: parseDecimalToMinorUnits("10"),
        total: parseDecimalToMinorUnits("165"),
        currency: "USD",
        idempotencyKey: "proposal_1",
      }).success,
    ).toBe(false);
  });

  it("rejects zero refund amounts and invalid refund kinds", () => {
    const base = {
      paymentId: "payment_1",
      amount: parseDecimalToMinorUnits("20"),
      currency: "USD",
      reason: "Damaged item",
      kind: "PARTIAL",
    };

    expect(RefundRequestSchema.safeParse(base).success).toBe(true);
    expect(RefundRequestSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
    expect(RefundRequestSchema.safeParse({ ...base, kind: "UNKNOWN" }).success).toBe(false);
  });
});
