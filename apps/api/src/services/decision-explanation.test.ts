import { describe, expect, it } from "vitest";
import { explainStoredDecision } from "./decision-explanation.js";

const rulesSnapshot = {
  title: "Headphones",
  productIntent: "Noise-cancelling headphones",
  currency: "USD",
  timezone: "UTC",
  allowedBrands: ["Sony", "Bose"],
  blockedBrands: [],
  allowedCategories: [],
  blockedCategories: [],
  allowedConditions: ["NEW"],
  autoSpendLimit: 15_000,
  transactionLimit: 18_000,
  weeklyLimit: 40_000,
  quantityLimit: 1,
  allowedMerchants: [],
  blockedMerchants: [],
  newMerchantRequiresApproval: false,
  startsAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-11-01T00:00:00.000Z",
};

const spendSnapshot = {
  currency: "USD",
  confirmed: { daily: 0, weekly: 10_000, monthly: 10_000 },
  otherReservations: [{ id: "r", amount: 5_000, currency: "USD", windows: ["WEEKLY"] }],
  isNewMerchant: true,
  globalAutonomousPurchasingEnabled: true,
};

function proposal(total: bigint, condition = "NEW") {
  return {
    total,
    currency: "USD",
    quantity: 1,
    productSnapshot: { brand: "Sony", category: "Headphones", condition, merchant: "Demo Store" },
    mandateVersion: { version: 3 },
  };
}

describe("stored decision explanations", () => {
  it("explains an ALLOW from the stored rules and BigInt totals", () => {
    const explanation = explainStoredDecision(
      { decision: "ALLOW", reasonCodes: [], rulesSnapshot, spendSnapshot },
      proposal(13_900n),
    );
    expect(explanation?.headline).toBe(
      "Within your mandate — $139 is under your $150 automatic limit",
    );
    expect(explanation?.checks.find((check) => check.rule === "weekly_limit")).toMatchObject({
      status: "pass",
      limit: "$400",
      actual: "$289",
    });
    expect(explanation?.checks.find((check) => check.rule === "mandate")?.actual).toBe(
      "Active · Version 3",
    );
  });

  it("explains BLOCK and REQUIRE_APPROVAL verdicts from stored codes", () => {
    expect(
      explainStoredDecision(
        {
          decision: "BLOCK",
          reasonCodes: ["TRANSACTION_LIMIT_EXCEEDED"],
          rulesSnapshot,
          spendSnapshot,
        },
        proposal(22_000n),
      ),
    ).toMatchObject({
      approvalCanOverride: false,
      headline: "Blocked by your mandate — $220 is above your $180 maximum per purchase",
    });
    expect(
      explainStoredDecision(
        {
          decision: "REQUIRE_APPROVAL",
          reasonCodes: ["AUTO_SPEND_THRESHOLD_EXCEEDED"],
          rulesSnapshot,
          spendSnapshot,
        },
        proposal(16_900n),
      )?.headline,
    ).toBe("Needs your approval — $169 is above your $150 automatic limit");
  });

  it("falls back to code-only copy when historical snapshots are malformed", () => {
    const explanation = explainStoredDecision(
      {
        decision: "BLOCK",
        reasonCodes: ["CONDITION_NOT_ALLOWED", 42],
        rulesSnapshot: { title: "partial" },
        spendSnapshot: { confirmed: { daily: -1 } },
      },
      null,
    );
    expect(explanation?.checks.find((check) => check.rule === "condition")).toMatchObject({
      status: "block",
      limit: null,
      actual: null,
    });
  });

  it("returns null for an unknown verdict instead of guessing", () => {
    expect(explainStoredDecision({ decision: "MAYBE", reasonCodes: [] })).toBeNull();
  });
});
