import type {
  ApprovalDecision,
  DecisionCheck,
  DecisionCheckStatus,
  DecisionExplanation,
} from "./types";

type Verdict = DecisionExplanation["decision"];

/**
 * Plain-language fallback for every AgentGuard reason code. The server's
 * explanation is preferred; this copy is used only when it is unavailable.
 */
export const REASON_COPY: Readonly<Record<string, string>> = Object.freeze({
  MANDATE_INACTIVE: "The mandate wasn’t active when AgentGuard checked this proposal.",
  MANDATE_NOT_STARTED: "The mandate hadn’t started yet when AgentGuard checked this proposal.",
  MANDATE_EXPIRED: "The mandate had expired when AgentGuard checked this proposal.",
  MANDATE_REVOKED: "The mandate was revoked, so it no longer permits purchases.",
  BRAND_NOT_ALLOWED: "This brand isn’t one of the brands your mandate allows.",
  BRAND_BLOCKED: "Your mandate blocks this brand.",
  CONDITION_NOT_ALLOWED: "Your mandate doesn’t allow this product condition.",
  CATEGORY_NOT_ALLOWED: "This category isn’t one your mandate allows.",
  CATEGORY_BLOCKED: "Your mandate blocks this category.",
  MERCHANT_NOT_ALLOWED: "This store isn’t one your mandate allows.",
  MERCHANT_BLOCKED: "Your mandate blocks this store.",
  QUANTITY_LIMIT_EXCEEDED: "The quantity is above your mandate’s quantity limit.",
  TRANSACTION_LIMIT_EXCEEDED: "The total is above your maximum per purchase.",
  DAILY_LIMIT_EXCEEDED: "This purchase would go over your daily spending limit.",
  WEEKLY_LIMIT_EXCEEDED: "This purchase would go over your weekly spending limit.",
  MONTHLY_LIMIT_EXCEEDED: "This purchase would go over your monthly spending limit.",
  GLOBAL_AUTONOMY_DISABLED:
    "Autonomous purchasing is turned off, so every purchase needs your approval.",
  AUTO_SPEND_THRESHOLD_EXCEEDED: "The amount is above your automatic spending limit.",
  NEW_MERCHANT_REQUIRES_APPROVAL: "This merchant is new for the mandate and needs your approval.",
  INVALID_POLICY_INPUT: "AgentGuard couldn’t verify the proposal details, so it failed safely.",
  PRODUCT_DATA_UNTRUSTED:
    "A product fact your mandate depends on was missing, so AgentGuard couldn’t confirm it.",
  MANDATE_ID_MISMATCH: "The proposal doesn’t belong to this mandate.",
  MANDATE_VERSION_MISMATCH: "The proposal was prepared for a different version of your mandate.",
  PROPOSAL_PRODUCT_MISMATCH: "The proposal doesn’t match the recorded product.",
  PROPOSAL_QUANTITY_MISMATCH: "The proposal quantity doesn’t match the recorded product.",
  PROPOSAL_TOTAL_MISMATCH: "The proposal total doesn’t add up.",
  PRODUCT_PRICE_MISMATCH: "The proposal price doesn’t match the recorded product price.",
  CURRENCY_MISMATCH: "The proposal currency doesn’t match your mandate’s currency.",
  SPEND_CONTEXT_INVALID: "AgentGuard couldn’t verify your spending records, so it failed safely.",
  PRODUCT_CONTENT_SUSPICIOUS:
    "This listing contains hidden or instruction-like text, so AgentGuard asks you to review it before any purchase.",
  PRODUCT_CONTENT_MALICIOUS:
    "This listing contains text that tries to instruct AI agents, so AgentGuard blocked it. Your mandate and PayPal were never touched.",
});

/** Which prompt-injection signal, if any, AgentGuard recorded for a decision. */
export function promptInjectionKind(
  decision: Pick<ApprovalDecision, "reasonCodes"> | null | undefined,
): "blocked" | "review" | null {
  if (!decision) return null;
  if (decision.reasonCodes.includes("PRODUCT_CONTENT_MALICIOUS")) return "blocked";
  if (decision.reasonCodes.includes("PRODUCT_CONTENT_SUSPICIOUS")) return "review";
  return null;
}

const APPROVAL_CODES = new Set([
  "GLOBAL_AUTONOMY_DISABLED",
  "AUTO_SPEND_THRESHOLD_EXCEEDED",
  "NEW_MERCHANT_REQUIRES_APPROVAL",
  "PRODUCT_CONTENT_SUSPICIOUS",
]);

const VERDICT_LABELS: Record<Verdict, string> = {
  ALLOW: "Allowed",
  REQUIRE_APPROVAL: "Needs your approval",
  BLOCK: "Blocked",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVerdict(value: unknown): value is Verdict {
  return value === "ALLOW" || value === "REQUIRE_APPROVAL" || value === "BLOCK";
}

function isStatus(value: unknown): value is DecisionCheckStatus {
  return value === "pass" || value === "approval" || value === "block";
}

function text(value: unknown, maximum = 600) {
  return typeof value === "string" && value.trim().length > 0 ? value.slice(0, maximum) : null;
}

function nullableText(value: unknown) {
  return value === null || value === undefined ? null : text(value, 120);
}

/** Validates the server's explanation; anything malformed is ignored, never trusted. */
export function readDecisionExplanation(value: unknown): DecisionExplanation | null {
  if (!isRecord(value) || !isVerdict(value.decision) || !Array.isArray(value.checks)) return null;
  const headline = text(value.headline, 300);
  const summary = text(value.summary);
  if (!headline || !summary || typeof value.approvalCanOverride !== "boolean") return null;
  const checks: DecisionCheck[] = [];
  for (const entry of value.checks.slice(0, 40)) {
    if (!isRecord(entry) || !isStatus(entry.status)) return null;
    const rule = text(entry.rule, 60);
    const label = text(entry.label, 80);
    const message = text(entry.message);
    if (!rule || !label || !message) return null;
    checks.push({
      rule,
      label,
      status: entry.status,
      limit: nullableText(entry.limit),
      actual: nullableText(entry.actual),
      message,
    });
  }
  return {
    decision: value.decision,
    headline,
    summary,
    approvalCanOverride: value.approvalCanOverride,
    checks,
  };
}

export function verdictLabel(decision: string | null | undefined) {
  return isVerdict(decision) ? VERDICT_LABELS[decision] : "Not evaluated";
}

/** Code-only checks used when the server explanation is unavailable. */
export function fallbackChecks(decision: ApprovalDecision): DecisionCheck[] {
  return decision.reasonCodes.map((code) => ({
    rule: code.toLowerCase(),
    label: APPROVAL_CODES.has(code) ? "Needs approval" : "Rule",
    status: APPROVAL_CODES.has(code) ? "approval" : "block",
    limit: null,
    actual: null,
    message: REASON_COPY[code] ?? "AgentGuard recorded an additional rule for this proposal.",
  }));
}

/** The best available explanation: the server's own, or a verdict-specific fallback. */
export function explainApprovalDecision(decision: ApprovalDecision): DecisionExplanation | null {
  if (decision.explanation) return decision.explanation;
  if (!isVerdict(decision.decision)) return null;
  const checks = fallbackChecks(decision);
  const first = checks.find((check) => check.status !== "pass");
  const reason = first ? ` — ${first.message.replace(/[.\s]+$/u, "")}` : "";
  if (decision.decision === "ALLOW") {
    return {
      decision: "ALLOW",
      headline: "Within your mandate — every rule passed",
      summary:
        "AgentGuard allowed this purchase without asking you. PayPal still asks you to confirm the payment before any money moves.",
      approvalCanOverride: true,
      checks,
    };
  }
  if (decision.decision === "REQUIRE_APPROVAL") {
    return {
      decision: "REQUIRE_APPROVAL",
      headline: `Needs your approval${reason}`,
      summary:
        "Every hard rule passed. Approve or reject this exact proposal; nothing is paid until you approve and confirm in PayPal.",
      approvalCanOverride: true,
      checks,
    };
  }
  if (promptInjectionKind(decision) === "blocked") {
    return {
      decision: "BLOCK",
      headline: "Prompt-injection attempt blocked — the listing tries to instruct AI agents",
      summary:
        "AgentGuard treats product text as data, never as instructions. This is a hard rule, so approval can’t override it and nothing can be paid for this proposal. Your mandate and PayPal were never touched.",
      approvalCanOverride: false,
      checks,
    };
  }
  return {
    decision: "BLOCK",
    headline: `Blocked by your mandate${reason}`,
    summary:
      "This is a hard rule, so approval can’t override it and nothing can be paid for this proposal. Change the mandate if you want to allow purchases like this.",
    approvalCanOverride: false,
    checks,
  };
}

/** One-line, verdict-specific reason text for compact surfaces. */
export function approvalReasonText(decision: ApprovalDecision | null) {
  if (!decision) return "AgentGuard has not recorded a reason for this proposal yet.";
  const explanation = explainApprovalDecision(decision);
  if (explanation) return explanation.headline;
  const known = decision.reasonCodes.map((code) => REASON_COPY[code]).filter(Boolean);
  return known.length
    ? known.join(" ")
    : "This proposal needs your review under the mandate rules.";
}
