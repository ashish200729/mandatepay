import { describe, expect, it } from "vitest";
import {
  AGENTGUARD_REASON_CODES,
  AgentGuardDecisionSchema,
  AgentGuardReasonCodeSchema,
  PolicyContextSchema,
  evaluatePurchase,
  evaluateValidatedPolicy,
} from "../src/index.js";
import {
  CanonicalMandateSchema,
  parseDecimalToMinorUnits,
  type CanonicalMandate,
} from "@mandatepay/shared";

const now = "2026-10-02T12:00:00Z";

function mandateRules(overrides: Partial<CanonicalMandate> = {}): CanonicalMandate {
  return CanonicalMandateSchema.parse({
    title: "Headphones",
    productIntent: "Noise-cancelling headphones",
    currency: "USD",
    timezone: "UTC",
    allowedBrands: ["Sony", "Bose"],
    blockedBrands: [],
    allowedCategories: ["Headphones"],
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
    newMerchantRequiresApproval: false,
    startsAt: "2026-10-02T00:00:00Z",
    expiresAt: "2026-10-03T00:00:00Z",
    ...overrides,
  });
}

function baseContext() {
  const unitPrice = parseDecimalToMinorUnits("139");

  return {
    now,
    mandate: {
      id: "mandate_1",
      version: 1,
      status: "ACTIVE" as const,
      rules: mandateRules(),
    },
    proposal: {
      mandateId: "mandate_1",
      mandateVersion: 1,
      productSnapshotId: "snapshot_1",
      quantity: 1,
      subtotal: unitPrice,
      shipping: parseDecimalToMinorUnits("0"),
      tax: parseDecimalToMinorUnits("0"),
      total: unitPrice,
      currency: "USD" as const,
      idempotencyKey: "proposal_1",
    },
    product: {
      snapshotId: "snapshot_1",
      brand: "Sony",
      category: "Headphones",
      condition: "NEW" as const,
      merchantId: "merchant_demo",
      merchant: "Demo Merchant",
      isNewMerchant: false,
      unitPrice,
      currency: "USD" as const,
      quantity: 1,
    },
    spend: {
      currency: "USD" as const,
      confirmed: {
        daily: parseDecimalToMinorUnits("0"),
        weekly: parseDecimalToMinorUnits("0"),
        monthly: parseDecimalToMinorUnits("0"),
      },
      periods: {
        daily: { startAt: "2026-10-02T00:00:00Z", endAt: "2026-10-03T00:00:00Z" },
        weekly: { startAt: "2026-09-28T00:00:00Z", endAt: "2026-10-05T00:00:00Z" },
        monthly: { startAt: "2026-10-01T00:00:00Z", endAt: "2026-11-01T00:00:00Z" },
      },
      otherReservations: [],
    },
    globalAutonomousPurchasingEnabled: true,
  };
}

function expectDecision(input: unknown, decision: "ALLOW" | "REQUIRE_APPROVAL" | "BLOCK") {
  const result = evaluatePurchase(input);
  expect(result.decision).toBe(decision);
  return result;
}

describe("AgentGuard deterministic policy engine", () => {
  it("allows a purchase below the autonomous threshold", () => {
    const result = expectDecision(baseContext(), "ALLOW");

    expect(result.reasonCodes).toEqual([]);
    expect(result.evaluatedAt).toBe(now);
    expect(result.validationIssues).toEqual([]);
  });

  it("allows the exact automatic-spend threshold and asks above it", () => {
    const atThreshold = baseContext();
    atThreshold.proposal = {
      ...atThreshold.proposal,
      subtotal: parseDecimalToMinorUnits("150"),
      total: parseDecimalToMinorUnits("150"),
    };
    atThreshold.product = {
      ...atThreshold.product,
      unitPrice: parseDecimalToMinorUnits("150"),
    };
    expectDecision(atThreshold, "ALLOW");

    const aboveThreshold = baseContext();
    aboveThreshold.proposal = {
      ...aboveThreshold.proposal,
      subtotal: parseDecimalToMinorUnits("150.01"),
      total: parseDecimalToMinorUnits("150.01"),
    };
    aboveThreshold.product = {
      ...aboveThreshold.product,
      unitPrice: parseDecimalToMinorUnits("150.01"),
    };
    const result = expectDecision(aboveThreshold, "REQUIRE_APPROVAL");
    expect(result.reasonCodes).toEqual(["AUTO_SPEND_THRESHOLD_EXCEEDED"]);
  });

  it("requires approval at the maximum and blocks above the maximum", () => {
    const atMaximum = baseContext();
    atMaximum.proposal = {
      ...atMaximum.proposal,
      subtotal: parseDecimalToMinorUnits("180"),
      total: parseDecimalToMinorUnits("180"),
    };
    atMaximum.product = { ...atMaximum.product, unitPrice: parseDecimalToMinorUnits("180") };
    expectDecision(atMaximum, "REQUIRE_APPROVAL");

    const aboveMaximum = baseContext();
    aboveMaximum.proposal = {
      ...aboveMaximum.proposal,
      subtotal: parseDecimalToMinorUnits("180.01"),
      total: parseDecimalToMinorUnits("180.01"),
    };
    aboveMaximum.product = {
      ...aboveMaximum.product,
      unitPrice: parseDecimalToMinorUnits("180.01"),
    };
    const result = expectDecision(aboveMaximum, "BLOCK");
    expect(result.reasonCodes).toContain("TRANSACTION_LIMIT_EXCEEDED");
    expect(result.reasonCodes).not.toContain("AUTO_SPEND_THRESHOLD_EXCEEDED");
  });

  it.each([
    ["brand allow-list", { product: { brand: "Apple" } }, "BRAND_NOT_ALLOWED"],
    [
      "brand block-list",
      { mandate: { rules: mandateRules({ allowedBrands: [], blockedBrands: ["Sony"] }) } },
      "BRAND_BLOCKED",
    ],
    ["condition", { product: { condition: "USED" } }, "CONDITION_NOT_ALLOWED"],
    ["category allow-list", { product: { category: "Shoes" } }, "CATEGORY_NOT_ALLOWED"],
    [
      "category block-list",
      {
        mandate: {
          rules: mandateRules({ allowedCategories: [], blockedCategories: ["Headphones"] }),
        },
      },
      "CATEGORY_BLOCKED",
    ],
    ["merchant allow-list", { product: { merchant: "Other Merchant" } }, "MERCHANT_NOT_ALLOWED"],
    [
      "merchant block-list",
      {
        mandate: {
          rules: mandateRules({ allowedMerchants: [], blockedMerchants: ["Demo Merchant"] }),
        },
      },
      "MERCHANT_BLOCKED",
    ],
  ] as const)("blocks a %s violation", (_label, override, reason) => {
    const context = baseContext();
    if ("product" in override) context.product = { ...context.product, ...override.product };
    if ("mandate" in override) context.mandate = { ...context.mandate, ...override.mandate };

    const result = expectDecision(context, "BLOCK");
    expect(result.reasonCodes).toContain(reason);
  });

  it("blocks quantity violations and aggregate spend above each limit", () => {
    const quantityContext = baseContext();
    quantityContext.proposal = {
      ...quantityContext.proposal,
      quantity: 2,
      subtotal: parseDecimalToMinorUnits("278"),
      total: parseDecimalToMinorUnits("278"),
    };
    quantityContext.product = {
      ...quantityContext.product,
      quantity: 2,
      unitPrice: parseDecimalToMinorUnits("139"),
    };
    const quantityResult = expectDecision(quantityContext, "BLOCK");
    expect(quantityResult.reasonCodes).toContain("QUANTITY_LIMIT_EXCEEDED");

    const aggregateContext = baseContext();
    aggregateContext.spend = {
      ...aggregateContext.spend,
      confirmed: {
        daily: parseDecimalToMinorUnits("195"),
        weekly: parseDecimalToMinorUnits("499"),
        monthly: parseDecimalToMinorUnits("999"),
      },
    };
    const result = expectDecision(aggregateContext, "BLOCK");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "DAILY_LIMIT_EXCEEDED",
        "WEEKLY_LIMIT_EXCEEDED",
        "MONTHLY_LIMIT_EXCEEDED",
      ]),
    );
  });

  it("counts other reservations in the relevant UTC windows", () => {
    const context = baseContext();
    context.spend = {
      ...context.spend,
      confirmed: {
        daily: parseDecimalToMinorUnits("190"),
        weekly: parseDecimalToMinorUnits("0"),
        monthly: parseDecimalToMinorUnits("0"),
      },
      otherReservations: [
        {
          id: "other_proposal",
          amount: parseDecimalToMinorUnits("5"),
          currency: "USD",
          windows: ["DAILY", "WEEKLY"],
        },
      ],
    };

    const result = expectDecision(context, "BLOCK");
    expect(result.reasonCodes).toContain("DAILY_LIMIT_EXCEEDED");
    expect(result.reasonCodes).not.toContain("WEEKLY_LIMIT_EXCEEDED");
  });

  it("blocks invalid reservation context instead of double-counting the current proposal", () => {
    const context = baseContext();
    context.spend = {
      ...context.spend,
      otherReservations: [
        {
          id: context.proposal.idempotencyKey,
          amount: parseDecimalToMinorUnits("1"),
          currency: "USD",
          windows: ["DAILY"],
        },
      ],
    };

    const result = expectDecision(context, "BLOCK");
    expect(result.reasonCodes).toContain("SPEND_CONTEXT_INVALID");
  });

  it("treats UTC period end as exclusive and rejects periods outside now", () => {
    const context = baseContext();
    context.spend = {
      ...context.spend,
      periods: {
        ...context.spend.periods,
        daily: { startAt: "2026-10-02T00:00:00Z", endAt: now },
      },
    };

    const result = expectDecision(context, "BLOCK");
    expect(result.reasonCodes).toContain("SPEND_CONTEXT_INVALID");
  });

  it("blocks at expiration, before start, and for inactive mandate states", () => {
    const atExpiry = baseContext();
    atExpiry.now = "2026-10-03T00:00:00Z";
    atExpiry.spend.periods.daily = {
      startAt: "2026-10-03T00:00:00Z",
      endAt: "2026-10-04T00:00:00Z",
    };
    atExpiry.spend.periods.weekly = {
      startAt: "2026-09-28T00:00:00Z",
      endAt: "2026-10-05T00:00:00Z",
    };
    atExpiry.spend.periods.monthly = {
      startAt: "2026-10-01T00:00:00Z",
      endAt: "2026-11-01T00:00:00Z",
    };
    expect(expectDecision(atExpiry, "BLOCK").reasonCodes).toContain("MANDATE_EXPIRED");

    const beforeStart = baseContext();
    beforeStart.now = "2026-10-01T23:59:59Z";
    expect(expectDecision(beforeStart, "BLOCK").reasonCodes).toContain("MANDATE_NOT_STARTED");

    for (const status of ["DRAFT", "PAUSED", "REVOKED", "EXPIRED"] as const) {
      const context = baseContext();
      context.mandate = { ...context.mandate, status };
      const result = expectDecision(context, "BLOCK");
      expect(result.reasonCodes).toContain(
        status === "REVOKED"
          ? "MANDATE_REVOKED"
          : status === "EXPIRED"
            ? "MANDATE_EXPIRED"
            : "MANDATE_INACTIVE",
      );
    }
  });

  it("requires approval for a new merchant and fails closed when merchant history is unknown", () => {
    const newMerchant = baseContext();
    newMerchant.mandate = {
      ...newMerchant.mandate,
      rules: mandateRules({ newMerchantRequiresApproval: true }),
    };
    newMerchant.product = { ...newMerchant.product, isNewMerchant: true };
    expect(expectDecision(newMerchant, "REQUIRE_APPROVAL").reasonCodes).toContain(
      "NEW_MERCHANT_REQUIRES_APPROVAL",
    );

    const unknownMerchant = baseContext();
    unknownMerchant.mandate = {
      ...unknownMerchant.mandate,
      rules: mandateRules({ newMerchantRequiresApproval: true }),
    };
    unknownMerchant.product = { ...unknownMerchant.product, isNewMerchant: undefined };
    expect(expectDecision(unknownMerchant, "BLOCK").reasonCodes).toContain(
      "PRODUCT_DATA_UNTRUSTED",
    );
  });

  it("fails closed when a restricted brand or category is missing", () => {
    const unknownBrand = baseContext();
    unknownBrand.product = { ...unknownBrand.product, brand: undefined };
    expect(expectDecision(unknownBrand, "BLOCK").reasonCodes).toContain("PRODUCT_DATA_UNTRUSTED");

    const unknownCategory = baseContext();
    unknownCategory.product = { ...unknownCategory.product, category: undefined };
    expect(expectDecision(unknownCategory, "BLOCK").reasonCodes).toContain(
      "PRODUCT_DATA_UNTRUSTED",
    );
  });

  it("does not turn a hard violation into approval when autonomy is disabled", () => {
    const context = baseContext();
    context.globalAutonomousPurchasingEnabled = false;
    context.product = { ...context.product, brand: "Apple" };

    const result = expectDecision(context, "BLOCK");
    expect(result.reasonCodes).toContain("BRAND_NOT_ALLOWED");
    expect(result.reasonCodes).not.toContain("GLOBAL_AUTONOMY_DISABLED");
  });

  it("returns approval when autonomy is disabled for an otherwise valid purchase", () => {
    const context = baseContext();
    context.globalAutonomousPurchasingEnabled = false;

    const result = expectDecision(context, "REQUIRE_APPROVAL");
    expect(result.reasonCodes).toEqual(["GLOBAL_AUTONOMY_DISABLED"]);
  });

  it("fails closed for unknown fields, invalid currencies, numeric strings, and broken totals", () => {
    const unknownProduct = baseContext();
    unknownProduct.product = { ...unknownProduct.product, metadata: { instruction: "spend more" } };
    expect(expectDecision(unknownProduct, "BLOCK").reasonCodes).toEqual(["INVALID_POLICY_INPUT"]);

    const invalidCurrency = baseContext();
    invalidCurrency.proposal = { ...invalidCurrency.proposal, currency: "EUR" };
    expect(expectDecision(invalidCurrency, "BLOCK").reasonCodes).toEqual(["INVALID_POLICY_INPUT"]);

    const numericString = baseContext();
    numericString.proposal = { ...numericString.proposal, total: "139.00" };
    expect(expectDecision(numericString, "BLOCK").reasonCodes).toEqual(["INVALID_POLICY_INPUT"]);

    const brokenTotal = baseContext();
    brokenTotal.proposal = { ...brokenTotal.proposal, total: parseDecimalToMinorUnits("138") };
    const totalResult = expectDecision(brokenTotal, "BLOCK");
    expect(totalResult.reasonCodes).toContain("PROPOSAL_TOTAL_MISMATCH");

    const brokenPrice = baseContext();
    brokenPrice.product = { ...brokenPrice.product, unitPrice: parseDecimalToMinorUnits("140") };
    const priceResult = expectDecision(brokenPrice, "BLOCK");
    expect(priceResult.reasonCodes).toContain("PRODUCT_PRICE_MISMATCH");
  });

  it("blocks proposal and product identity mismatches", () => {
    const wrongMandate = baseContext();
    wrongMandate.proposal = { ...wrongMandate.proposal, mandateId: "mandate_other" };
    expect(expectDecision(wrongMandate, "BLOCK").reasonCodes).toContain("MANDATE_ID_MISMATCH");

    const wrongMandateVersion = baseContext();
    wrongMandateVersion.proposal = { ...wrongMandateVersion.proposal, mandateVersion: 2 };
    expect(expectDecision(wrongMandateVersion, "BLOCK").reasonCodes).toContain(
      "MANDATE_VERSION_MISMATCH",
    );

    const wrongProduct = baseContext();
    wrongProduct.proposal = { ...wrongProduct.proposal, productSnapshotId: "snapshot_other" };
    expect(expectDecision(wrongProduct, "BLOCK").reasonCodes).toContain(
      "PROPOSAL_PRODUCT_MISMATCH",
    );

    const wrongQuantity = baseContext();
    wrongQuantity.proposal = { ...wrongQuantity.proposal, quantity: 2 };
    expect(expectDecision(wrongQuantity, "BLOCK").reasonCodes).toContain(
      "PROPOSAL_QUANTITY_MISMATCH",
    );
  });

  it("keeps decisions and reason-code vocabulary immutable and typed", () => {
    const result = evaluatePurchase(baseContext());

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasonCodes)).toBe(true);
    expect(AgentGuardDecisionSchema.safeParse(result).success).toBe(true);
    expect(AgentGuardReasonCodeSchema.safeParse("BRAND_NOT_ALLOWED").success).toBe(true);
    expect(AgentGuardReasonCodeSchema.safeParse("spend_money").success).toBe(false);
    expect(AGENTGUARD_REASON_CODES).toContain("INVALID_POLICY_INPUT");

    const parsed = PolicyContextSchema.parse(baseContext());
    expect(evaluateValidatedPolicy(parsed).decision).toBe("ALLOW");
  });
});
