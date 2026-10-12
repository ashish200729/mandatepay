import {
  AGENTGUARD_REASON_CODES,
  type AgentGuardReasonCode,
  type SharedPolicyDecision,
} from "./contracts.js";

/**
 * Deterministic, read-only explanations of a recorded AgentGuard decision.
 *
 * The recorded decision and reason codes stay authoritative: every check status
 * is derived from those codes, never recomputed from the facts. Facts (rules
 * snapshot, totals, spend) only supply the limit and actual values shown to the
 * user. Nothing here can change a decision.
 */

export type DecisionCheckStatus = "pass" | "approval" | "block";

export type DecisionRule =
  | "mandate"
  | "policy_input"
  | "proposal_integrity"
  | "product_data"
  | "product_content"
  | "currency"
  | "brand"
  | "category"
  | "condition"
  | "merchant"
  | "quantity"
  | "transaction_limit"
  | "daily_limit"
  | "weekly_limit"
  | "monthly_limit"
  | "spend_context"
  | "autonomy"
  | "automatic_limit"
  | "new_merchant"
  | "other";

export interface DecisionCheck {
  readonly rule: DecisionRule;
  readonly label: string;
  readonly status: DecisionCheckStatus;
  readonly limit: string | null;
  readonly actual: string | null;
  readonly message: string;
}

export interface DecisionExplanation {
  readonly decision: SharedPolicyDecision;
  readonly headline: string;
  readonly summary: string;
  /** False for BLOCK: a hard rule cannot be overridden by an approval. */
  readonly approvalCanOverride: boolean;
  readonly checks: readonly DecisionCheck[];
}

/** Rule values read from a stored canonical mandate snapshot (integer minor units). */
export interface ExplainableRules {
  readonly currency: string;
  readonly allowedBrands: readonly string[];
  readonly blockedBrands: readonly string[];
  readonly allowedCategories: readonly string[];
  readonly blockedCategories: readonly string[];
  readonly allowedConditions: readonly string[];
  readonly allowedMerchants: readonly string[];
  readonly blockedMerchants: readonly string[];
  readonly autoSpendLimit: number;
  readonly transactionLimit: number;
  readonly dailyLimit?: number | undefined;
  readonly weeklyLimit?: number | undefined;
  readonly monthlyLimit?: number | undefined;
  readonly quantityLimit: number;
  readonly newMerchantRequiresApproval: boolean;
  readonly expiresAt?: string | undefined;
}

export interface ExplainDecisionInput {
  readonly decision: SharedPolicyDecision;
  readonly reasonCodes: readonly string[];
  readonly rules?: ExplainableRules | null;
  readonly mandateVersion?: number | null;
  readonly proposal?: {
    readonly total: number;
    readonly currency: string;
    readonly quantity: number;
  } | null;
  readonly product?: {
    readonly brand: string | null;
    readonly category: string | null;
    readonly condition: string | null;
    readonly merchant: string | null;
  } | null;
  /** Confirmed spend plus other active reservations, excluding this proposal. */
  readonly committedSpend?: {
    readonly daily: number;
    readonly weekly: number;
    readonly monthly: number;
  } | null;
  readonly isNewMerchant?: boolean | null;
  /** The user's own autonomy setting recorded with the decision, when known. */
  readonly userAutonomyEnabled?: boolean | null;
}

const RULE_LABELS: Record<DecisionRule, string> = {
  mandate: "Mandate status",
  policy_input: "Policy input",
  proposal_integrity: "Proposal integrity",
  product_data: "Product facts",
  product_content: "Listing content",
  currency: "Currency",
  brand: "Brand",
  category: "Category",
  condition: "Condition",
  merchant: "Store",
  quantity: "Quantity",
  transaction_limit: "Maximum per purchase",
  daily_limit: "Daily limit",
  weekly_limit: "Weekly limit",
  monthly_limit: "Monthly limit",
  spend_context: "Spending records",
  autonomy: "Autonomous purchasing",
  automatic_limit: "Automatic limit",
  new_merchant: "New store",
  other: "Other rule",
};

const CODE_RULES: Record<AgentGuardReasonCode, DecisionRule> = {
  MANDATE_INACTIVE: "mandate",
  MANDATE_NOT_STARTED: "mandate",
  MANDATE_EXPIRED: "mandate",
  MANDATE_REVOKED: "mandate",
  MANDATE_ID_MISMATCH: "mandate",
  MANDATE_VERSION_MISMATCH: "mandate",
  BRAND_NOT_ALLOWED: "brand",
  BRAND_BLOCKED: "brand",
  CONDITION_NOT_ALLOWED: "condition",
  CATEGORY_NOT_ALLOWED: "category",
  CATEGORY_BLOCKED: "category",
  MERCHANT_NOT_ALLOWED: "merchant",
  MERCHANT_BLOCKED: "merchant",
  QUANTITY_LIMIT_EXCEEDED: "quantity",
  TRANSACTION_LIMIT_EXCEEDED: "transaction_limit",
  DAILY_LIMIT_EXCEEDED: "daily_limit",
  WEEKLY_LIMIT_EXCEEDED: "weekly_limit",
  MONTHLY_LIMIT_EXCEEDED: "monthly_limit",
  GLOBAL_AUTONOMY_DISABLED: "autonomy",
  AUTO_SPEND_THRESHOLD_EXCEEDED: "automatic_limit",
  NEW_MERCHANT_REQUIRES_APPROVAL: "new_merchant",
  INVALID_POLICY_INPUT: "policy_input",
  PRODUCT_DATA_UNTRUSTED: "product_data",
  PROPOSAL_PRODUCT_MISMATCH: "proposal_integrity",
  PROPOSAL_QUANTITY_MISMATCH: "proposal_integrity",
  PROPOSAL_TOTAL_MISMATCH: "proposal_integrity",
  PRODUCT_PRICE_MISMATCH: "proposal_integrity",
  CURRENCY_MISMATCH: "currency",
  SPEND_CONTEXT_INVALID: "spend_context",
  PRODUCT_CONTENT_SUSPICIOUS: "product_content",
  PRODUCT_CONTENT_MALICIOUS: "product_content",
};

const APPROVAL_CODES: ReadonlySet<AgentGuardReasonCode> = new Set([
  "GLOBAL_AUTONOMY_DISABLED",
  "AUTO_SPEND_THRESHOLD_EXCEEDED",
  "NEW_MERCHANT_REQUIRES_APPROVAL",
  "PRODUCT_CONTENT_SUSPICIOUS",
]);

/** Plain-language copy for every reason code, used when facts are unavailable. */
export const REASON_CODE_MESSAGES: Readonly<Record<AgentGuardReasonCode, string>> = Object.freeze({
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
  AUTO_SPEND_THRESHOLD_EXCEEDED: "The total is above your automatic spending limit.",
  NEW_MERCHANT_REQUIRES_APPROVAL:
    "This is a new store for you, and your mandate asks before buying from new stores.",
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

/** True when a recorded decision stopped a listing that tried to instruct AI agents. */
export function isPromptInjectionBlock(reasonCodes: readonly string[]): boolean {
  return reasonCodes.includes("PRODUCT_CONTENT_MALICIOUS");
}

const KNOWN_CODES: ReadonlySet<string> = new Set(AGENTGUARD_REASON_CODES);

function isKnownCode(value: string): value is AgentGuardReasonCode {
  return KNOWN_CODES.has(value);
}

function isSafeMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Formats integer minor units. Whole amounts omit cents ($139); others keep them ($139.50). */
export function formatMinorMoney(minor: number, currency = "USD"): string {
  if (!isSafeMinor(minor)) return "—";
  const value = BigInt(minor);
  const whole = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const cents = (value % 100n).toString().padStart(2, "0");
  const amount = cents === "00" ? whole : `${whole}.${cents}`;
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}

const CONDITION_LABELS: Record<string, string> = {
  NEW: "new",
  USED: "used",
  REFURBISHED: "refurbished",
};

export function conditionLabel(value: string | null | undefined): string {
  if (!value) return "unknown";
  return CONDITION_LABELS[value] ?? value.toLowerCase();
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function list(values: readonly string[], conjunction = "or"): string {
  if (values.length <= 1) return values.join("");
  if (values.length === 2) return `${values[0]} ${conjunction} ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, ${conjunction} ${values.at(-1)}`;
}

function includesNormalized(values: readonly string[], value: string | null | undefined) {
  if (!value) return false;
  const needle = value.trim().toLocaleLowerCase("en-US");
  return values.some((entry) => entry.trim().toLocaleLowerCase("en-US") === needle);
}

function withoutPeriod(value: string): string {
  return value.replace(/[.\s]+$/u, "");
}

type Facts = {
  rules: ExplainableRules | null;
  money: (minor: number) => string;
  total: number | null;
  quantity: number | null;
  currency: string | null;
};

function check(
  rule: DecisionRule,
  status: DecisionCheckStatus,
  message: string,
  limit: string | null = null,
  actual: string | null = null,
): DecisionCheck {
  return Object.freeze({ rule, label: RULE_LABELS[rule], status, limit, actual, message });
}

function restrictionCheck(
  rule: "brand" | "category" | "merchant",
  noun: string,
  value: string | null,
  allowed: readonly string[],
  blocked: readonly string[],
  codes: ReadonlySet<AgentGuardReasonCode>,
  notAllowedCode: AgentGuardReasonCode,
  blockedCode: AgentGuardReasonCode,
): DecisionCheck | null {
  const configured = allowed.length > 0 || blocked.length > 0;
  const failedNotAllowed = codes.has(notAllowedCode);
  const failedBlocked = codes.has(blockedCode);
  if (!configured && !failedNotAllowed && !failedBlocked) return null;
  // Missing product facts are reported by the product-facts check instead.
  if (!value && !failedNotAllowed && !failedBlocked) return null;
  const limit = allowed.length ? list(allowed) : blocked.length ? `Not ${list(blocked)}` : null;
  const shown = value ?? "Unknown";
  if (failedBlocked) {
    return check(rule, "block", `Your mandate blocks ${shown} as a ${noun}.`, limit, shown);
  }
  if (failedNotAllowed) {
    return check(
      rule,
      "block",
      allowed.length
        ? `${shown} isn’t an allowed ${noun}; your mandate allows ${list(allowed)}.`
        : REASON_CODE_MESSAGES[notAllowedCode],
      limit,
      shown,
    );
  }
  return check(
    rule,
    "pass",
    allowed.length
      ? `${shown} is an allowed ${noun}.`
      : `${shown} isn’t on your blocked ${noun} list.`,
    limit,
    shown,
  );
}

function windowCheck(
  rule: "daily_limit" | "weekly_limit" | "monthly_limit",
  period: "daily" | "weekly" | "monthly",
  limit: number | undefined,
  committed: number | null,
  facts: Facts,
  failed: boolean,
  code: AgentGuardReasonCode,
): DecisionCheck | null {
  if (limit === undefined && !failed) return null;
  const projected =
    facts.total !== null && committed !== null && isSafeMinor(committed)
      ? committed + facts.total
      : null;
  const limitText = limit === undefined ? null : facts.money(limit);
  const actualText = projected === null ? null : facts.money(projected);
  if (failed) {
    return check(
      rule,
      "block",
      limitText && actualText
        ? `This purchase would bring your ${period} spending to ${actualText}, above your ${limitText} ${period} limit.`
        : REASON_CODE_MESSAGES[code],
      limitText,
      actualText,
    );
  }
  return check(
    rule,
    "pass",
    limitText && actualText
      ? `Your ${period} spending would be ${actualText}, within your ${limitText} ${period} limit.`
      : `Within your ${period} spending limit.`,
    limitText,
    actualText,
  );
}

function mandateCheck(
  codes: ReadonlySet<AgentGuardReasonCode>,
  version: number | null,
): DecisionCheck {
  const failed = [
    "MANDATE_REVOKED",
    "MANDATE_EXPIRED",
    "MANDATE_NOT_STARTED",
    "MANDATE_INACTIVE",
    "MANDATE_VERSION_MISMATCH",
    "MANDATE_ID_MISMATCH",
  ].filter((code): code is AgentGuardReasonCode => codes.has(code as AgentGuardReasonCode));
  const versionText = version ? `Version ${version}` : null;
  if (failed.length) {
    return check(
      "mandate",
      "block",
      failed.map((code) => REASON_CODE_MESSAGES[code]).join(" "),
      "Active",
      failed.includes("MANDATE_REVOKED")
        ? "Revoked"
        : failed.includes("MANDATE_EXPIRED")
          ? "Expired"
          : failed.includes("MANDATE_NOT_STARTED")
            ? "Not started"
            : failed.includes("MANDATE_INACTIVE")
              ? "Inactive"
              : "Different version",
    );
  }
  return check(
    "mandate",
    "pass",
    version
      ? `Your mandate (version ${version}) was active and in date.`
      : "Your mandate was active and in date.",
    "Active",
    versionText ? `Active · ${versionText}` : "Active",
  );
}

function integrityChecks(codes: ReadonlySet<AgentGuardReasonCode>): DecisionCheck[] {
  const result: DecisionCheck[] = [];
  const integrity = (
    [
      "PROPOSAL_PRODUCT_MISMATCH",
      "PROPOSAL_QUANTITY_MISMATCH",
      "PROPOSAL_TOTAL_MISMATCH",
      "PRODUCT_PRICE_MISMATCH",
    ] as const
  ).filter((code) => codes.has(code));
  if (integrity.length) {
    result.push(
      check(
        "proposal_integrity",
        "block",
        integrity.map((code) => REASON_CODE_MESSAGES[code]).join(" "),
      ),
    );
  }
  if (codes.has("PRODUCT_DATA_UNTRUSTED")) {
    result.push(check("product_data", "block", REASON_CODE_MESSAGES.PRODUCT_DATA_UNTRUSTED));
  }
  if (codes.has("SPEND_CONTEXT_INVALID")) {
    result.push(check("spend_context", "block", REASON_CODE_MESSAGES.SPEND_CONTEXT_INVALID));
  }
  return result;
}

function productContentCheck(codes: ReadonlySet<AgentGuardReasonCode>): DecisionCheck | null {
  if (codes.has("PRODUCT_CONTENT_MALICIOUS")) {
    return check(
      "product_content",
      "block",
      REASON_CODE_MESSAGES.PRODUCT_CONTENT_MALICIOUS,
      "Product data only",
      "Instructions to AI agents",
    );
  }
  if (codes.has("PRODUCT_CONTENT_SUSPICIOUS")) {
    return check(
      "product_content",
      "approval",
      REASON_CODE_MESSAGES.PRODUCT_CONTENT_SUSPICIOUS,
      "Product data only",
      "Instruction-like text",
    );
  }
  return null;
}

function autonomyCheck(
  codes: ReadonlySet<AgentGuardReasonCode>,
  userAutonomyEnabled: boolean | null,
): DecisionCheck {
  if (codes.has("GLOBAL_AUTONOMY_DISABLED")) {
    return check(
      "autonomy",
      "approval",
      userAutonomyEnabled === true
        ? "Autonomous purchasing is paused for everyone right now, so this purchase needs your approval."
        : "Autonomous purchasing is turned off in Settings, so every purchase needs your approval.",
      "On",
      "Off",
    );
  }
  return check(
    "autonomy",
    "pass",
    "Autonomous purchasing is on, so AgentGuard may allow purchases under your automatic limit.",
    "On",
    "On",
  );
}

function automaticLimitCheck(
  codes: ReadonlySet<AgentGuardReasonCode>,
  facts: Facts,
): DecisionCheck | null {
  const failed = codes.has("AUTO_SPEND_THRESHOLD_EXCEEDED");
  if (!facts.rules) {
    return failed
      ? check("automatic_limit", "approval", REASON_CODE_MESSAGES.AUTO_SPEND_THRESHOLD_EXCEEDED)
      : null;
  }
  const limit = facts.money(facts.rules.autoSpendLimit);
  const actual = facts.total === null ? null : facts.money(facts.total);
  if (failed) {
    return check(
      "automatic_limit",
      "approval",
      facts.rules.autoSpendLimit === 0
        ? "Your mandate asks before every purchase (automatic limit $0)."
        : actual
          ? `${actual} is above your ${limit} automatic limit.`
          : REASON_CODE_MESSAGES.AUTO_SPEND_THRESHOLD_EXCEEDED,
      limit,
      actual,
    );
  }
  return check(
    "automatic_limit",
    "pass",
    actual
      ? facts.total !== null && facts.total < facts.rules.autoSpendLimit
        ? `${actual} is under your ${limit} automatic limit.`
        : `${actual} is within your ${limit} automatic limit.`
      : `Within your ${limit} automatic limit.`,
    limit,
    actual,
  );
}

function newMerchantCheck(
  codes: ReadonlySet<AgentGuardReasonCode>,
  facts: Facts,
  merchant: string | null,
  isNewMerchant: boolean | null,
): DecisionCheck | null {
  const failed = codes.has("NEW_MERCHANT_REQUIRES_APPROVAL");
  if (!failed && !facts.rules?.newMerchantRequiresApproval) return null;
  const store = merchant ?? "This store";
  if (failed) {
    return check(
      "new_merchant",
      "approval",
      `${store} is a new store for you, and your mandate asks before buying from new stores.`,
      "Ask for new stores",
      "New store",
    );
  }
  return check(
    "new_merchant",
    "pass",
    isNewMerchant === false
      ? `You’ve bought from ${store} before.`
      : "No new-store approval was needed.",
    "Ask for new stores",
    isNewMerchant === false ? "Known store" : null,
  );
}

function headlineFor(
  decision: SharedPolicyDecision,
  checks: readonly DecisionCheck[],
  facts: Facts,
): { headline: string; summary: string } {
  if (decision === "BLOCK") {
    const blocked = checks.filter((entry) => entry.status === "block");
    const first = blocked[0];
    if (first?.rule === "product_content") {
      const others =
        blocked.length > 1
          ? ` ${blocked.length - 1} more rule${blocked.length > 2 ? "s" : ""} also failed.`
          : "";
      return {
        headline: "Prompt-injection attempt blocked — the listing tries to instruct AI agents",
        summary: `AgentGuard treats product text as data, never as instructions. This is a hard rule, so approval can’t override it and nothing can be paid for this proposal.${others} Your mandate and PayPal were never touched.`,
      };
    }
    const integrity = first
      ? [
          "policy_input",
          "proposal_integrity",
          "product_data",
          "product_content",
          "spend_context",
        ].includes(first.rule)
      : false;
    const headline = first
      ? `${integrity ? "Blocked for safety" : "Blocked by your mandate"} — ${withoutPeriod(first.message)}`
      : "Blocked by your mandate";
    const others =
      blocked.length > 1
        ? ` ${blocked.length - 1} more rule${blocked.length > 2 ? "s" : ""} also failed.`
        : "";
    return {
      headline,
      summary: `This is a hard rule, so approval can’t override it and nothing can be paid for this proposal.${others} Change the mandate if you want to allow purchases like this.`,
    };
  }
  if (decision === "REQUIRE_APPROVAL") {
    const needs = checks.filter((entry) => entry.status === "approval");
    const first = needs[0];
    const rest = needs.slice(1).map((entry) => entry.message);
    return {
      headline: first
        ? `Needs your approval — ${withoutPeriod(first.message)}`
        : "Needs your approval",
      summary: `${rest.length ? `${rest.join(" ")} ` : ""}Every hard rule passed. Approve or reject this exact proposal; nothing is paid until you approve and confirm in PayPal.`,
    };
  }
  const automatic = checks.find((entry) => entry.rule === "automatic_limit");
  const headline =
    automatic && automatic.status === "pass" && facts.total !== null && facts.rules
      ? `Within your mandate — ${withoutPeriod(automatic.message)}`
      : "Within your mandate — every rule passed";
  return {
    headline,
    summary:
      "AgentGuard allowed this purchase without asking you. PayPal still asks you to confirm the payment before any money moves.",
  };
}

/** Builds an ordered, user-facing explanation of a recorded AgentGuard decision. */
export function explainDecision(input: ExplainDecisionInput): DecisionExplanation {
  const known = input.reasonCodes.filter(isKnownCode);
  const unknownCount = input.reasonCodes.length - known.length;
  const codes: ReadonlySet<AgentGuardReasonCode> = new Set(known);
  const proposal = input.proposal ?? null;
  const currency = proposal?.currency ?? input.rules?.currency ?? "USD";
  const facts: Facts = {
    rules: input.rules ?? null,
    money: (minor) => formatMinorMoney(minor, currency),
    total: proposal && isSafeMinor(proposal.total) ? proposal.total : null,
    quantity:
      proposal && Number.isSafeInteger(proposal.quantity) && proposal.quantity > 0
        ? proposal.quantity
        : null,
    currency: proposal?.currency ?? null,
  };
  const checks: DecisionCheck[] = [];

  if (codes.has("INVALID_POLICY_INPUT")) {
    // The engine evaluated nothing else; showing other rules as passed would be false.
    checks.push(check("policy_input", "block", REASON_CODE_MESSAGES.INVALID_POLICY_INPUT));
  } else {
    // An injection attempt is named first so the headline reports it, whatever else failed.
    const content = productContentCheck(codes);
    if (content) checks.push(content);
    checks.push(mandateCheck(codes, input.mandateVersion ?? null));
    checks.push(...integrityChecks(codes));

    const rules = facts.rules;
    const currencyFailed = codes.has("CURRENCY_MISMATCH");
    if (rules || currencyFailed) {
      checks.push(
        check(
          "currency",
          currencyFailed ? "block" : "pass",
          currencyFailed
            ? REASON_CODE_MESSAGES.CURRENCY_MISMATCH
            : `Priced in ${rules?.currency ?? facts.currency ?? "the mandate currency"}, your mandate’s currency.`,
          rules?.currency ?? null,
          facts.currency,
        ),
      );
    }

    const product = input.product ?? null;
    const brand = restrictionCheck(
      "brand",
      "brand",
      product?.brand ?? null,
      rules?.allowedBrands ?? [],
      rules?.blockedBrands ?? [],
      codes,
      "BRAND_NOT_ALLOWED",
      "BRAND_BLOCKED",
    );
    if (brand) checks.push(brand);
    const category = restrictionCheck(
      "category",
      "category",
      product?.category ?? null,
      rules?.allowedCategories ?? [],
      rules?.blockedCategories ?? [],
      codes,
      "CATEGORY_NOT_ALLOWED",
      "CATEGORY_BLOCKED",
    );
    if (category) checks.push(category);

    const conditionFailed = codes.has("CONDITION_NOT_ALLOWED");
    if (rules || conditionFailed) {
      const allowed = (rules?.allowedConditions ?? []).map(conditionLabel);
      const actual = product?.condition ? capitalize(conditionLabel(product.condition)) : null;
      const limit = allowed.length ? capitalize(`${list(allowed)} only`) : null;
      checks.push(
        check(
          "condition",
          conditionFailed ? "block" : "pass",
          conditionFailed
            ? allowed.length
              ? `Your mandate allows ${list(allowed)} only; this one is ${conditionLabel(product?.condition)}.`
              : REASON_CODE_MESSAGES.CONDITION_NOT_ALLOWED
            : actual
              ? `${actual} matches your allowed condition.`
              : "The condition matches your mandate.",
          limit,
          actual,
        ),
      );
    }

    const merchant = restrictionCheck(
      "merchant",
      "store",
      product?.merchant ?? null,
      rules?.allowedMerchants ?? [],
      rules?.blockedMerchants ?? [],
      codes,
      "MERCHANT_NOT_ALLOWED",
      "MERCHANT_BLOCKED",
    );
    if (merchant) checks.push(merchant);

    const quantityFailed = codes.has("QUANTITY_LIMIT_EXCEEDED");
    if (rules || quantityFailed) {
      const limit = rules ? String(rules.quantityLimit) : null;
      const actual = facts.quantity === null ? null : String(facts.quantity);
      checks.push(
        check(
          "quantity",
          quantityFailed ? "block" : "pass",
          quantityFailed
            ? limit && actual
              ? `A quantity of ${actual} is above your limit of ${limit}.`
              : REASON_CODE_MESSAGES.QUANTITY_LIMIT_EXCEEDED
            : limit && actual
              ? `A quantity of ${actual} is within your limit of ${limit}.`
              : "The quantity is within your limit.",
          limit,
          actual,
        ),
      );
    }

    const transactionFailed = codes.has("TRANSACTION_LIMIT_EXCEEDED");
    if (rules || transactionFailed) {
      const limit = rules ? facts.money(rules.transactionLimit) : null;
      const actual = facts.total === null ? null : facts.money(facts.total);
      checks.push(
        check(
          "transaction_limit",
          transactionFailed ? "block" : "pass",
          transactionFailed
            ? limit && actual
              ? `${actual} is above your ${limit} maximum per purchase.`
              : REASON_CODE_MESSAGES.TRANSACTION_LIMIT_EXCEEDED
            : limit && actual
              ? `${actual} is within your ${limit} maximum per purchase.`
              : "The total is within your maximum per purchase.",
          limit,
          actual,
        ),
      );
    }

    const committed = input.committedSpend ?? null;
    for (const [rule, period, limit, code] of [
      ["daily_limit", "daily", rules?.dailyLimit, "DAILY_LIMIT_EXCEEDED"],
      ["weekly_limit", "weekly", rules?.weeklyLimit, "WEEKLY_LIMIT_EXCEEDED"],
      ["monthly_limit", "monthly", rules?.monthlyLimit, "MONTHLY_LIMIT_EXCEEDED"],
    ] as const) {
      const entry = windowCheck(
        rule,
        period,
        limit,
        committed ? committed[period] : null,
        facts,
        codes.has(code),
        code,
      );
      if (entry) checks.push(entry);
    }

    // The engine considers approval signals only after every hard rule passes.
    // Proposal-specific signals come first so the headline names the purchase's own reason.
    if (input.decision !== "BLOCK") {
      const automatic = automaticLimitCheck(codes, facts);
      if (automatic) checks.push(automatic);
      const newMerchant = newMerchantCheck(
        codes,
        facts,
        product?.merchant ?? null,
        input.isNewMerchant ?? null,
      );
      if (newMerchant) checks.push(newMerchant);
      checks.push(autonomyCheck(codes, input.userAutonomyEnabled ?? null));
    } else {
      for (const code of known) {
        if (APPROVAL_CODES.has(code) && code !== "PRODUCT_CONTENT_SUSPICIOUS") {
          checks.push(check(CODE_RULES[code], "approval", REASON_CODE_MESSAGES[code]));
        }
      }
    }
  }

  if (unknownCount > 0) {
    checks.push(
      check(
        "other",
        input.decision === "REQUIRE_APPROVAL"
          ? "approval"
          : input.decision === "BLOCK"
            ? "block"
            : "pass",
        "AgentGuard recorded an additional rule for this proposal.",
      ),
    );
  }

  // Never let a derived explanation contradict the recorded verdict.
  if (input.decision === "BLOCK" && !checks.some((entry) => entry.status === "block")) {
    checks.push(check("other", "block", "AgentGuard blocked this proposal under your mandate."));
  }
  if (
    input.decision === "REQUIRE_APPROVAL" &&
    !checks.some((entry) => entry.status === "approval")
  ) {
    checks.push(check("other", "approval", "This proposal needs your review under the mandate."));
  }

  const { headline, summary } = headlineFor(input.decision, checks, facts);
  return Object.freeze({
    decision: input.decision,
    headline,
    summary,
    approvalCanOverride: input.decision !== "BLOCK",
    checks: Object.freeze(checks),
  });
}

/** Reason a discovered product falls outside a mandate before any proposal exists. */
export interface ProductScreeningReason {
  readonly rule: "currency" | "brand" | "category" | "condition" | "merchant" | "transaction_limit";
  readonly message: string;
}

export interface ScreenableProduct {
  readonly brand: string | null;
  readonly categories: readonly string[];
  readonly condition: string;
  readonly merchant: string;
  readonly priceMinor: number;
  readonly currency: string;
}

/**
 * Discovery-time screening for display only. AgentGuard still evaluates any
 * proposal; this never authorizes a purchase.
 */
export function screenProductAgainstMandate(
  rules: ExplainableRules,
  product: ScreenableProduct,
): readonly ProductScreeningReason[] {
  const reasons: ProductScreeningReason[] = [];
  const money = (minor: number) => formatMinorMoney(minor, rules.currency);
  if (product.currency !== rules.currency) {
    reasons.push({
      rule: "currency",
      message: `Priced in ${product.currency}; your mandate uses ${rules.currency}.`,
    });
  }
  if (rules.allowedBrands.length && !includesNormalized(rules.allowedBrands, product.brand)) {
    reasons.push({
      rule: "brand",
      message: `${product.brand ?? "This brand"} isn’t an allowed brand; your mandate allows ${list(rules.allowedBrands)}.`,
    });
  } else if (includesNormalized(rules.blockedBrands, product.brand)) {
    reasons.push({ rule: "brand", message: `Your mandate blocks ${product.brand} as a brand.` });
  }
  const categories = product.categories;
  if (
    rules.allowedCategories.length &&
    !rules.allowedCategories.some((category) => includesNormalized(categories, category))
  ) {
    reasons.push({
      rule: "category",
      message: `This category isn’t one your mandate allows (${list(rules.allowedCategories)}).`,
    });
  } else if (rules.blockedCategories.some((category) => includesNormalized(categories, category))) {
    reasons.push({ rule: "category", message: "Your mandate blocks this category." });
  }
  if (!rules.allowedConditions.includes(product.condition)) {
    reasons.push({
      rule: "condition",
      message: `Your mandate allows ${list(rules.allowedConditions.map(conditionLabel))} only; this one is ${conditionLabel(product.condition)}.`,
    });
  }
  if (
    rules.allowedMerchants.length &&
    !includesNormalized(rules.allowedMerchants, product.merchant)
  ) {
    reasons.push({
      rule: "merchant",
      message: `${product.merchant} isn’t one of your allowed stores (${list(rules.allowedMerchants)}).`,
    });
  } else if (includesNormalized(rules.blockedMerchants, product.merchant)) {
    reasons.push({ rule: "merchant", message: `Your mandate blocks ${product.merchant}.` });
  }
  if (product.currency === rules.currency && product.priceMinor > rules.transactionLimit) {
    reasons.push({
      rule: "transaction_limit",
      message: `${money(product.priceMinor)} is above your ${money(rules.transactionLimit)} maximum per purchase.`,
    });
  }
  return Object.freeze(reasons);
}
