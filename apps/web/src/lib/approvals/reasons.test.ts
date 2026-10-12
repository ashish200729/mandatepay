import { describe, expect, it } from "vitest";
import {
  REASON_COPY,
  approvalReasonText,
  explainApprovalDecision,
  readDecisionExplanation,
  promptInjectionKind,
  verdictLabel,
} from "./reasons";

const ALL_CODES = [
  "MANDATE_INACTIVE",
  "MANDATE_NOT_STARTED",
  "MANDATE_EXPIRED",
  "MANDATE_REVOKED",
  "BRAND_NOT_ALLOWED",
  "BRAND_BLOCKED",
  "CONDITION_NOT_ALLOWED",
  "CATEGORY_NOT_ALLOWED",
  "CATEGORY_BLOCKED",
  "MERCHANT_NOT_ALLOWED",
  "MERCHANT_BLOCKED",
  "QUANTITY_LIMIT_EXCEEDED",
  "TRANSACTION_LIMIT_EXCEEDED",
  "DAILY_LIMIT_EXCEEDED",
  "WEEKLY_LIMIT_EXCEEDED",
  "MONTHLY_LIMIT_EXCEEDED",
  "GLOBAL_AUTONOMY_DISABLED",
  "AUTO_SPEND_THRESHOLD_EXCEEDED",
  "NEW_MERCHANT_REQUIRES_APPROVAL",
  "INVALID_POLICY_INPUT",
  "PRODUCT_DATA_UNTRUSTED",
  "MANDATE_ID_MISMATCH",
  "MANDATE_VERSION_MISMATCH",
  "PROPOSAL_PRODUCT_MISMATCH",
  "PROPOSAL_QUANTITY_MISMATCH",
  "PROPOSAL_TOTAL_MISMATCH",
  "PRODUCT_PRICE_MISMATCH",
  "CURRENCY_MISMATCH",
  "SPEND_CONTEXT_INVALID",
  "PRODUCT_CONTENT_SUSPICIOUS",
  "PRODUCT_CONTENT_MALICIOUS",
];

const serverExplanation = {
  decision: "ALLOW",
  headline: "Within your mandate — $139 is under your $150 automatic limit",
  summary: "AgentGuard allowed this purchase without asking you.",
  approvalCanOverride: true,
  checks: [
    {
      rule: "automatic_limit",
      label: "Automatic limit",
      status: "pass",
      limit: "$150",
      actual: "$139",
      message: "$139 is under your $150 automatic limit.",
    },
  ],
};

describe("approval reason copy", () => {
  it.each(ALL_CODES)("has plain-language fallback copy for %s", (code) => {
    expect(REASON_COPY[code]?.length).toBeGreaterThan(10);
    expect(REASON_COPY[code]).not.toContain(code);
  });

  it("prefers the server's verdict-specific explanation", () => {
    expect(
      approvalReasonText({
        decision: "ALLOW",
        reasonCodes: [],
        explanation: readDecisionExplanation(serverExplanation),
      }),
    ).toBe("Within your mandate — $139 is under your $150 automatic limit");
  });

  it("uses verdict-specific fallback copy instead of a generic review message", () => {
    expect(approvalReasonText({ decision: "ALLOW", reasonCodes: [] })).toBe(
      "Within your mandate — every rule passed",
    );
    expect(
      approvalReasonText({
        decision: "REQUIRE_APPROVAL",
        reasonCodes: ["AUTO_SPEND_THRESHOLD_EXCEEDED"],
      }),
    ).toBe("Needs your approval — The amount is above your automatic spending limit");
    const blocked = explainApprovalDecision({
      decision: "BLOCK",
      reasonCodes: ["TRANSACTION_LIMIT_EXCEEDED"],
    });
    expect(blocked).toMatchObject({
      headline: "Blocked by your mandate — The total is above your maximum per purchase",
      approvalCanOverride: false,
      checks: [{ status: "block", message: REASON_COPY.TRANSACTION_LIMIT_EXCEEDED }],
    });
    expect(blocked?.summary).toContain("approval can’t override it");
  });

  it("does not expose unknown machine codes", () => {
    const text = approvalReasonText({ decision: "REQUIRE_APPROVAL", reasonCodes: ["SECRET_CODE"] });
    expect(text).not.toContain("SECRET_CODE");
    expect(text).toContain("Needs your approval");
    expect(approvalReasonText(null)).toBe(
      "AgentGuard has not recorded a reason for this proposal yet.",
    );
  });

  it("ignores malformed server explanations", () => {
    expect(readDecisionExplanation(null)).toBeNull();
    expect(readDecisionExplanation({ ...serverExplanation, decision: "MAYBE" })).toBeNull();
    expect(
      readDecisionExplanation({
        ...serverExplanation,
        checks: [{ ...serverExplanation.checks[0], status: "unknown" }],
      }),
    ).toBeNull();
    expect(readDecisionExplanation({ ...serverExplanation, headline: "" })).toBeNull();
    expect(readDecisionExplanation(serverExplanation)?.checks[0]).toEqual(
      serverExplanation.checks[0],
    );
  });

  it("labels verdicts in plain language", () => {
    expect(verdictLabel("ALLOW")).toBe("Allowed");
    expect(verdictLabel("REQUIRE_APPROVAL")).toBe("Needs your approval");
    expect(verdictLabel("BLOCK")).toBe("Blocked");
    expect(verdictLabel(undefined)).toBe("Not evaluated");
  });

  it("names a blocked prompt-injection attempt in the fallback explanation", () => {
    const blocked = explainApprovalDecision({
      decision: "BLOCK",
      reasonCodes: ["PRODUCT_CONTENT_MALICIOUS"],
    });
    expect(blocked).toMatchObject({
      headline: "Prompt-injection attempt blocked — the listing tries to instruct AI agents",
      approvalCanOverride: false,
      checks: [{ status: "block", message: REASON_COPY.PRODUCT_CONTENT_MALICIOUS }],
    });
    expect(blocked?.summary).toContain("Your mandate and PayPal were never touched.");
    const review = explainApprovalDecision({
      decision: "REQUIRE_APPROVAL",
      reasonCodes: ["PRODUCT_CONTENT_SUSPICIOUS"],
    });
    expect(review?.checks[0]?.status).toBe("approval");
    expect(promptInjectionKind({ reasonCodes: ["PRODUCT_CONTENT_MALICIOUS"] })).toBe("blocked");
    expect(promptInjectionKind({ reasonCodes: ["PRODUCT_CONTENT_SUSPICIOUS"] })).toBe("review");
    expect(promptInjectionKind({ reasonCodes: ["BRAND_NOT_ALLOWED"] })).toBeNull();
    expect(promptInjectionKind(null)).toBeNull();
  });
});
