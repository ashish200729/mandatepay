import { describe, expect, it } from "vitest";
import {
  AGENTGUARD_REASON_CODES,
  REASON_CODE_MESSAGES,
  evaluatePurchase,
  explainDecision,
  formatMinorMoney,
  isPromptInjectionBlock,
  screenProductAgainstMandate,
  type AgentGuardReasonCode,
  type ExplainDecisionInput,
  type ExplainableRules,
} from "../src/index.js";

const rules: ExplainableRules = {
  currency: "USD",
  allowedBrands: ["Sony", "Bose"],
  blockedBrands: [],
  allowedCategories: [],
  blockedCategories: [],
  allowedConditions: ["NEW"],
  allowedMerchants: [],
  blockedMerchants: [],
  autoSpendLimit: 15_000,
  transactionLimit: 18_000,
  dailyLimit: 30_000,
  quantityLimit: 1,
  newMerchantRequiresApproval: true,
};

function input(overrides: Partial<ExplainDecisionInput> = {}): ExplainDecisionInput {
  return {
    decision: "ALLOW",
    reasonCodes: [],
    rules,
    mandateVersion: 2,
    proposal: { total: 13_900, currency: "USD", quantity: 1 },
    product: { brand: "Sony", category: "Headphones", condition: "NEW", merchant: "Demo Store" },
    committedSpend: { daily: 5_000, weekly: 5_000, monthly: 5_000 },
    isNewMerchant: false,
    userAutonomyEnabled: true,
    ...overrides,
  };
}

const APPROVAL_CODES = new Set<AgentGuardReasonCode>([
  "GLOBAL_AUTONOMY_DISABLED",
  "AUTO_SPEND_THRESHOLD_EXCEEDED",
  "NEW_MERCHANT_REQUIRES_APPROVAL",
  "PRODUCT_CONTENT_SUSPICIOUS",
]);

describe("explainDecision", () => {
  it("explains an ALLOW with the automatic limit and every passing check", () => {
    const explanation = explainDecision(input());
    expect(explanation.headline).toBe(
      "Within your mandate — $139 is under your $150 automatic limit",
    );
    expect(explanation.approvalCanOverride).toBe(true);
    expect(explanation.checks.every((check) => check.status === "pass")).toBe(true);
    expect(explanation.checks.map((check) => check.rule)).toEqual([
      "mandate",
      "currency",
      "brand",
      "condition",
      "quantity",
      "transaction_limit",
      "daily_limit",
      "automatic_limit",
      "new_merchant",
      "autonomy",
    ]);
    expect(explanation.checks.find((check) => check.rule === "daily_limit")).toMatchObject({
      limit: "$300",
      actual: "$189",
    });
    expect(explanation.summary).toContain("PayPal still asks you to confirm");
  });

  it("treats the exact automatic limit as within it", () => {
    const explanation = explainDecision(
      input({ proposal: { total: 15_000, currency: "USD", quantity: 1 } }),
    );
    expect(explanation.headline).toBe(
      "Within your mandate — $150 is within your $150 automatic limit",
    );
  });

  it("explains what needs approval and why", () => {
    const explanation = explainDecision(
      input({
        decision: "REQUIRE_APPROVAL",
        reasonCodes: ["AUTO_SPEND_THRESHOLD_EXCEEDED"],
        proposal: { total: 16_900, currency: "USD", quantity: 1 },
      }),
    );
    expect(explanation.headline).toBe(
      "Needs your approval — $169 is above your $150 automatic limit",
    );
    expect(explanation.checks.find((check) => check.rule === "automatic_limit")).toMatchObject({
      status: "approval",
      limit: "$150",
      actual: "$169",
    });
    expect(explanation.summary).toContain("Every hard rule passed");
  });

  it("explains a hard block and that approval cannot override it", () => {
    const explanation = explainDecision(
      input({
        decision: "BLOCK",
        reasonCodes: ["TRANSACTION_LIMIT_EXCEEDED"],
        proposal: { total: 22_000, currency: "USD", quantity: 1 },
      }),
    );
    expect(explanation.headline).toBe(
      "Blocked by your mandate — $220 is above your $180 maximum per purchase",
    );
    expect(explanation.approvalCanOverride).toBe(false);
    expect(explanation.summary).toContain("approval can’t override it");
    // Approval-tier signals are not evaluated once a hard rule fails.
    expect(explanation.checks.some((check) => check.rule === "automatic_limit")).toBe(false);
  });

  it("names the failing product facts for condition and brand", () => {
    const refurbished = explainDecision(
      input({
        decision: "BLOCK",
        reasonCodes: ["CONDITION_NOT_ALLOWED"],
        product: { brand: "Bose", category: null, condition: "REFURBISHED", merchant: "Demo" },
      }),
    );
    expect(refurbished.headline).toBe(
      "Blocked by your mandate — Your mandate allows new only; this one is refurbished",
    );
    const beats = explainDecision(
      input({
        decision: "BLOCK",
        reasonCodes: ["BRAND_NOT_ALLOWED"],
        product: { brand: "Beats", category: null, condition: "NEW", merchant: "Demo" },
      }),
    );
    expect(beats.checks.find((check) => check.rule === "brand")).toMatchObject({
      status: "block",
      limit: "Sony or Bose",
      actual: "Beats",
      message: "Beats isn’t an allowed brand; your mandate allows Sony or Bose.",
    });
  });

  it("reports spending windows with committed spend and the new total", () => {
    const explanation = explainDecision(
      input({
        decision: "BLOCK",
        reasonCodes: ["DAILY_LIMIT_EXCEEDED"],
        committedSpend: { daily: 20_000, weekly: 20_000, monthly: 20_000 },
      }),
    );
    expect(explanation.checks.find((check) => check.rule === "daily_limit")).toMatchObject({
      status: "block",
      limit: "$300",
      actual: "$339",
    });
  });

  it("explains a new store and autonomy being off", () => {
    const explanation = explainDecision(
      input({
        decision: "REQUIRE_APPROVAL",
        reasonCodes: ["GLOBAL_AUTONOMY_DISABLED", "NEW_MERCHANT_REQUIRES_APPROVAL"],
        product: {
          brand: "Sony",
          category: null,
          condition: "NEW",
          merchant: "Northwind Audio",
        },
        isNewMerchant: true,
        userAutonomyEnabled: false,
      }),
    );
    expect(explanation.headline).toBe(
      "Needs your approval — Northwind Audio is a new store for you, and your mandate asks before buying from new stores",
    );
    expect(explanation.summary).toContain("Autonomous purchasing is turned off in Settings");
    const paused = explainDecision(
      input({ decision: "REQUIRE_APPROVAL", reasonCodes: ["GLOBAL_AUTONOMY_DISABLED"] }),
    );
    expect(paused.headline).toContain("paused for everyone");
  });

  it.each(AGENTGUARD_REASON_CODES.map((code) => [code]))(
    "explains %s without exposing the machine code",
    (code) => {
      const decision = APPROVAL_CODES.has(code) ? "REQUIRE_APPROVAL" : "BLOCK";
      for (const facts of [input(), input({ rules: null, proposal: null, product: null })]) {
        const explanation = explainDecision({ ...facts, decision, reasonCodes: [code] });
        const flagged = explanation.checks.filter((check) => check.status !== "pass");
        expect(flagged.length).toBeGreaterThan(0);
        expect(flagged.every((check) => check.message.length > 10)).toBe(true);
        expect(
          flagged.some((check) =>
            decision === "BLOCK" && !APPROVAL_CODES.has(code)
              ? check.status === "block"
              : check.status === "approval",
          ),
        ).toBe(true);
        const text = JSON.stringify(explanation);
        expect(text).not.toContain(code);
        expect(explanation.headline.length).toBeGreaterThan(10);
      }
      expect(REASON_CODE_MESSAGES[code].length).toBeGreaterThan(10);
    },
  );

  it("fails closed for unknown codes and never contradicts the verdict", () => {
    const explanation = explainDecision(
      input({ decision: "BLOCK", reasonCodes: ["SOMETHING_NEW"] }),
    );
    expect(explanation.checks.some((check) => check.status === "block")).toBe(true);
    expect(JSON.stringify(explanation)).not.toContain("SOMETHING_NEW");
  });

  it("shows only the input failure when the engine evaluated nothing else", () => {
    const explanation = explainDecision(
      input({ decision: "BLOCK", reasonCodes: ["INVALID_POLICY_INPUT"] }),
    );
    expect(explanation.checks).toHaveLength(1);
    expect(explanation.headline).toContain("Blocked for safety");
  });

  it("stays consistent with real engine decisions", () => {
    const base = {
      now: "2026-10-02T12:00:00Z",
      mandate: {
        id: "m",
        version: 1,
        status: "ACTIVE",
        rules: {
          title: "Headphones",
          productIntent: "Headphones",
          currency: "USD",
          timezone: "UTC",
          allowedBrands: ["Sony", "Bose"],
          blockedBrands: [],
          allowedCategories: [],
          blockedCategories: [],
          allowedConditions: ["NEW"],
          autoSpendLimit: 15_000,
          transactionLimit: 18_000,
          quantityLimit: 1,
          allowedMerchants: [],
          blockedMerchants: [],
          newMerchantRequiresApproval: false,
        },
      },
      spend: {
        currency: "USD",
        confirmed: { daily: 0, weekly: 0, monthly: 0 },
        periods: {
          daily: { startAt: "2026-10-02T00:00:00Z", endAt: "2026-10-03T00:00:00Z" },
          weekly: { startAt: "2026-09-28T00:00:00Z", endAt: "2026-10-05T00:00:00Z" },
          monthly: { startAt: "2026-10-01T00:00:00Z", endAt: "2026-11-01T00:00:00Z" },
        },
        otherReservations: [],
      },
      globalAutonomousPurchasingEnabled: true,
    };
    for (const [price, condition, expected] of [
      [13_900, "NEW", "ALLOW"],
      [16_900, "NEW", "REQUIRE_APPROVAL"],
      [22_000, "NEW", "BLOCK"],
      [12_000, "REFURBISHED", "BLOCK"],
    ] as const) {
      const decision = evaluatePurchase({
        ...base,
        proposal: {
          mandateId: "m",
          mandateVersion: 1,
          productSnapshotId: "s",
          quantity: 1,
          subtotal: price,
          shipping: 0,
          tax: 0,
          total: price,
          currency: "USD",
          idempotencyKey: "k",
        },
        product: {
          snapshotId: "s",
          brand: "Sony",
          condition,
          merchantId: "d",
          merchant: "Demo",
          isNewMerchant: false,
          unitPrice: price,
          currency: "USD",
          quantity: 1,
        },
      });
      expect(decision.decision).toBe(expected);
      const explanation = explainDecision({
        decision: decision.decision,
        reasonCodes: decision.reasonCodes,
        rules: base.mandate.rules,
        proposal: { total: price, currency: "USD", quantity: 1 },
        product: { brand: "Sony", category: null, condition, merchant: "Demo" },
      });
      const statuses = new Set(explanation.checks.map((check) => check.status));
      expect(statuses.has("block")).toBe(expected === "BLOCK");
      expect(statuses.has("approval")).toBe(expected === "REQUIRE_APPROVAL");
    }
  });
});

describe("formatMinorMoney", () => {
  it("formats integer cents without floating point", () => {
    expect(formatMinorMoney(13_900)).toBe("$139");
    expect(formatMinorMoney(13_950)).toBe("$139.50");
    expect(formatMinorMoney(123_456_789)).toBe("$1,234,567.89");
    expect(formatMinorMoney(5)).toBe("$0.05");
    expect(formatMinorMoney(-1)).toBe("—");
    expect(formatMinorMoney(1.5)).toBe("—");
  });
});

describe("screenProductAgainstMandate", () => {
  const product = {
    brand: "Sony",
    categories: ["Headphones"],
    condition: "NEW",
    merchant: "Demo",
    priceMinor: 13_900,
    currency: "USD",
  };

  it("passes a product inside the mandate", () => {
    expect(screenProductAgainstMandate(rules, product)).toEqual([]);
  });

  it("names every mandate rule a product falls outside", () => {
    expect(screenProductAgainstMandate(rules, { ...product, condition: "REFURBISHED" })).toEqual([
      { rule: "condition", message: "Your mandate allows new only; this one is refurbished." },
    ]);
    expect(screenProductAgainstMandate(rules, { ...product, priceMinor: 22_000 })).toEqual([
      { rule: "transaction_limit", message: "$220 is above your $180 maximum per purchase." },
    ]);
    expect(
      screenProductAgainstMandate(rules, { ...product, brand: "Beats" }).map((r) => r.rule),
    ).toEqual(["brand"]);
    expect(
      screenProductAgainstMandate(
        {
          ...rules,
          allowedCategories: ["Headphones"],
          blockedBrands: [],
          allowedMerchants: ["Demo Store"],
        },
        { ...product, categories: ["Speakers"], merchant: "Elsewhere", currency: "EUR" },
      ).map((reason) => reason.rule),
    ).toEqual(["currency", "category", "merchant"]);
    expect(
      screenProductAgainstMandate(
        { ...rules, allowedBrands: [], blockedBrands: ["sony"], blockedMerchants: ["demo"] },
        product,
      ).map((reason) => reason.rule),
    ).toEqual(["brand", "merchant"]);
  });
});

describe("prompt-injection explanations", () => {
  it("names a blocked injection attempt first and never offers approval", () => {
    const explanation = explainDecision(
      input({
        decision: "BLOCK",
        reasonCodes: ["PRODUCT_CONTENT_MALICIOUS", "BRAND_NOT_ALLOWED"],
        product: { brand: "Beats", category: "Headphones", condition: "NEW", merchant: "Demo" },
      }),
    );
    expect(explanation.approvalCanOverride).toBe(false);
    expect(explanation.headline).toBe(
      "Prompt-injection attempt blocked — the listing tries to instruct AI agents",
    );
    expect(explanation.summary).toContain("Your mandate and PayPal were never touched.");
    expect(explanation.summary).toContain("1 more rule also failed.");
    expect(explanation.checks[0]).toMatchObject({
      rule: "product_content",
      label: "Listing content",
      status: "block",
      message:
        "This listing contains text that tries to instruct AI agents, so AgentGuard blocked it. Your mandate and PayPal were never touched.",
    });
    expect(isPromptInjectionBlock(["PRODUCT_CONTENT_MALICIOUS"])).toBe(true);
    expect(isPromptInjectionBlock(["PRODUCT_CONTENT_SUSPICIOUS"])).toBe(false);
  });

  it("asks for review of suspicious listing text once, before other approval reasons", () => {
    const explanation = explainDecision(
      input({
        decision: "REQUIRE_APPROVAL",
        reasonCodes: ["AUTO_SPEND_THRESHOLD_EXCEEDED", "PRODUCT_CONTENT_SUSPICIOUS"],
        proposal: { total: 16_900, currency: "USD", quantity: 1 },
      }),
    );
    expect(explanation.approvalCanOverride).toBe(true);
    expect(explanation.headline).toContain("hidden or instruction-like text");
    expect(explanation.checks.filter((check) => check.rule === "product_content")).toHaveLength(1);
    expect(explanation.checks.find((check) => check.rule === "automatic_limit")?.status).toBe(
      "approval",
    );
  });

  it("omits the listing check when screening found nothing", () => {
    const explanation = explainDecision(input());
    expect(explanation.checks.some((check) => check.rule === "product_content")).toBe(false);
  });
});
