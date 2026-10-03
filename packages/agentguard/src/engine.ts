import {
  addMinorUnits,
  calculatePurchaseTotal,
  multiplyMinorUnits,
  toMinorUnits,
  type MinorUnits,
} from "@mandatepay/shared";
import { DomainError } from "@mandatepay/shared";
import { z } from "zod";
import {
  AGENTGUARD_REASON_CODES,
  AgentGuardReasonCodeSchema,
  PolicyContextSchema,
  type AgentGuardDecision,
  type AgentGuardReasonCode,
  type PolicyContext,
  type SpendTotals,
} from "./contracts.js";

type MutableReasonCodes = AgentGuardReasonCode[];

function addReasonCode(codes: MutableReasonCodes, code: AgentGuardReasonCode): void {
  if (!codes.includes(code)) {
    codes.push(code);
  }
}

function freezeDecision(
  decision: AgentGuardDecision["decision"],
  reasonCodes: readonly AgentGuardReasonCode[],
  evaluatedAt: string | null,
  validationIssues: readonly string[] = [],
): AgentGuardDecision {
  return Object.freeze({
    decision,
    reasonCodes: Object.freeze([...reasonCodes]),
    evaluatedAt,
    validationIssues: Object.freeze([...validationIssues]),
  });
}

function invalidInputDecision(error: z.ZodError): AgentGuardDecision {
  const validationIssues = error.issues.slice(0, 12).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "context";
    return `${path}: ${issue.message}`;
  });

  return freezeDecision("BLOCK", ["INVALID_POLICY_INPUT"], null, validationIssues);
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function includesNormalized(values: readonly string[], candidate: string): boolean {
  const normalizedCandidate = normalize(candidate);
  return values.some((value) => normalize(value) === normalizedCandidate);
}

function evaluateStringRestriction(
  value: string | undefined,
  allowedValues: readonly string[],
  blockedValues: readonly string[],
  allowedReason: AgentGuardReasonCode,
  blockedReason: AgentGuardReasonCode,
): MutableReasonCodes {
  const reasons: MutableReasonCodes = [];

  if ((allowedValues.length > 0 || blockedValues.length > 0) && value === undefined) {
    reasons.push("PRODUCT_DATA_UNTRUSTED");
    return reasons;
  }

  if (
    value !== undefined &&
    allowedValues.length > 0 &&
    !includesNormalized(allowedValues, value)
  ) {
    reasons.push(allowedReason);
  }

  if (value !== undefined && blockedValues.length > 0 && includesNormalized(blockedValues, value)) {
    reasons.push(blockedReason);
  }

  return reasons;
}

function evaluateMandateState(context: PolicyContext, hardReasons: MutableReasonCodes): void {
  const { mandate, now } = context;

  switch (mandate.status) {
    case "REVOKED":
      addReasonCode(hardReasons, "MANDATE_REVOKED");
      break;
    case "EXPIRED":
      addReasonCode(hardReasons, "MANDATE_EXPIRED");
      break;
    case "ACTIVE":
      break;
    default:
      addReasonCode(hardReasons, "MANDATE_INACTIVE");
  }

  if (mandate.rules.startsAt && Date.parse(now) < Date.parse(mandate.rules.startsAt)) {
    addReasonCode(hardReasons, "MANDATE_NOT_STARTED");
  }

  if (mandate.rules.expiresAt && Date.parse(now) >= Date.parse(mandate.rules.expiresAt)) {
    addReasonCode(hardReasons, "MANDATE_EXPIRED");
  }
}

function evaluateProposalContract(context: PolicyContext, hardReasons: MutableReasonCodes): void {
  const { mandate, product, proposal } = context;

  if (proposal.mandateId !== mandate.id) {
    addReasonCode(hardReasons, "MANDATE_ID_MISMATCH");
  }

  if (proposal.mandateVersion !== mandate.version) {
    addReasonCode(hardReasons, "MANDATE_VERSION_MISMATCH");
  }

  if (proposal.productSnapshotId !== product.snapshotId) {
    addReasonCode(hardReasons, "PROPOSAL_PRODUCT_MISMATCH");
  }

  if (proposal.quantity !== product.quantity) {
    addReasonCode(hardReasons, "PROPOSAL_QUANTITY_MISMATCH");
  }

  if (
    proposal.currency !== mandate.rules.currency ||
    product.currency !== mandate.rules.currency ||
    proposal.currency !== product.currency
  ) {
    addReasonCode(hardReasons, "CURRENCY_MISMATCH");
  }

  try {
    const expectedTotal = calculatePurchaseTotal({
      subtotal: proposal.subtotal,
      shipping: proposal.shipping,
      tax: proposal.tax,
    });
    if (expectedTotal !== proposal.total) {
      addReasonCode(hardReasons, "PROPOSAL_TOTAL_MISMATCH");
    }
  } catch (error) {
    if (error instanceof DomainError) {
      addReasonCode(hardReasons, "PROPOSAL_TOTAL_MISMATCH");
    } else {
      throw error;
    }
  }

  try {
    const expectedSubtotal = multiplyMinorUnits(product.unitPrice, product.quantity);
    if (expectedSubtotal !== proposal.subtotal) {
      addReasonCode(hardReasons, "PRODUCT_PRICE_MISMATCH");
    }
  } catch (error) {
    if (error instanceof DomainError) {
      addReasonCode(hardReasons, "PRODUCT_PRICE_MISMATCH");
    } else {
      throw error;
    }
  }
}

function evaluateProductRules(context: PolicyContext, hardReasons: MutableReasonCodes): void {
  const { product } = context;
  const rules = context.mandate.rules;

  for (const reason of evaluateStringRestriction(
    product.brand,
    rules.allowedBrands,
    rules.blockedBrands,
    "BRAND_NOT_ALLOWED",
    "BRAND_BLOCKED",
  )) {
    addReasonCode(hardReasons, reason);
  }

  for (const reason of evaluateStringRestriction(
    product.category,
    rules.allowedCategories,
    rules.blockedCategories,
    "CATEGORY_NOT_ALLOWED",
    "CATEGORY_BLOCKED",
  )) {
    addReasonCode(hardReasons, reason);
  }

  if (!rules.allowedConditions.includes(product.condition)) {
    addReasonCode(hardReasons, "CONDITION_NOT_ALLOWED");
  }

  for (const reason of evaluateStringRestriction(
    product.merchant,
    rules.allowedMerchants,
    rules.blockedMerchants,
    "MERCHANT_NOT_ALLOWED",
    "MERCHANT_BLOCKED",
  )) {
    addReasonCode(hardReasons, reason);
  }
}

function sumReservations(
  context: PolicyContext,
  hardReasons: MutableReasonCodes,
): SpendTotals | null {
  const totals: Record<keyof SpendTotals, MinorUnits> = {
    daily: toMinorUnits(0),
    weekly: toMinorUnits(0),
    monthly: toMinorUnits(0),
  };

  const windowKeys = {
    DAILY: "daily",
    WEEKLY: "weekly",
    MONTHLY: "monthly",
  } as const;

  for (const reservation of context.spend.otherReservations) {
    if (reservation.id === context.proposal.idempotencyKey) {
      addReasonCode(hardReasons, "SPEND_CONTEXT_INVALID");
    }

    if (reservation.currency !== context.mandate.rules.currency) {
      addReasonCode(hardReasons, "CURRENCY_MISMATCH");
    }

    for (const window of reservation.windows) {
      const key = windowKeys[window];
      try {
        totals[key] = addMinorUnits(totals[key], reservation.amount);
      } catch (error) {
        if (error instanceof DomainError) {
          addReasonCode(hardReasons, "SPEND_CONTEXT_INVALID");
        } else {
          throw error;
        }
      }
    }
  }

  return totals;
}

function validateSpendPeriods(context: PolicyContext, hardReasons: MutableReasonCodes): void {
  const now = Date.parse(context.now);
  const periods = [
    context.spend.periods.daily,
    context.spend.periods.weekly,
    context.spend.periods.monthly,
  ];

  for (const period of periods) {
    const start = Date.parse(period.startAt);
    const end = Date.parse(period.endAt);
    if (now < start || now >= end) {
      addReasonCode(hardReasons, "SPEND_CONTEXT_INVALID");
    }
  }
}

function evaluateAggregateLimits(
  context: PolicyContext,
  reservationTotals: SpendTotals,
  hardReasons: MutableReasonCodes,
): void {
  const { confirmed } = context.spend;
  const total = context.proposal.total;
  let aggregate: SpendTotals;

  try {
    aggregate = {
      daily: addMinorUnits(confirmed.daily, reservationTotals.daily, total),
      weekly: addMinorUnits(confirmed.weekly, reservationTotals.weekly, total),
      monthly: addMinorUnits(confirmed.monthly, reservationTotals.monthly, total),
    };
  } catch (error) {
    if (error instanceof DomainError) {
      addReasonCode(hardReasons, "SPEND_CONTEXT_INVALID");
      return;
    }
    throw error;
  }

  const rules = context.mandate.rules;
  if (rules.dailyLimit !== undefined && aggregate.daily > rules.dailyLimit) {
    addReasonCode(hardReasons, "DAILY_LIMIT_EXCEEDED");
  }
  if (rules.weeklyLimit !== undefined && aggregate.weekly > rules.weeklyLimit) {
    addReasonCode(hardReasons, "WEEKLY_LIMIT_EXCEEDED");
  }
  if (rules.monthlyLimit !== undefined && aggregate.monthly > rules.monthlyLimit) {
    addReasonCode(hardReasons, "MONTHLY_LIMIT_EXCEEDED");
  }
}

function evaluateValidatedPurchase(context: PolicyContext): AgentGuardDecision {
  const hardReasons: MutableReasonCodes = [];
  const approvalReasons: MutableReasonCodes = [];

  evaluateMandateState(context, hardReasons);
  evaluateProposalContract(context, hardReasons);
  evaluateProductRules(context, hardReasons);

  if (context.proposal.quantity > context.mandate.rules.quantityLimit) {
    addReasonCode(hardReasons, "QUANTITY_LIMIT_EXCEEDED");
  }

  if (context.proposal.total > context.mandate.rules.transactionLimit) {
    addReasonCode(hardReasons, "TRANSACTION_LIMIT_EXCEEDED");
  }

  if (
    context.spend.currency !== context.mandate.rules.currency ||
    context.spend.currency !== context.proposal.currency
  ) {
    addReasonCode(hardReasons, "CURRENCY_MISMATCH");
  }

  validateSpendPeriods(context, hardReasons);
  const reservationTotals = sumReservations(context, hardReasons);
  if (reservationTotals) {
    evaluateAggregateLimits(context, reservationTotals, hardReasons);
  }

  if (context.mandate.rules.newMerchantRequiresApproval) {
    if (context.product.isNewMerchant === undefined) {
      addReasonCode(hardReasons, "PRODUCT_DATA_UNTRUSTED");
    }
  }

  if (hardReasons.length > 0) {
    return freezeDecision("BLOCK", hardReasons, context.now);
  }

  if (!context.globalAutonomousPurchasingEnabled) {
    addReasonCode(approvalReasons, "GLOBAL_AUTONOMY_DISABLED");
  }

  if (context.proposal.total > context.mandate.rules.autoSpendLimit) {
    addReasonCode(approvalReasons, "AUTO_SPEND_THRESHOLD_EXCEEDED");
  }

  if (context.mandate.rules.newMerchantRequiresApproval && context.product.isNewMerchant === true) {
    addReasonCode(approvalReasons, "NEW_MERCHANT_REQUIRES_APPROVAL");
  }

  if (approvalReasons.length > 0) {
    return freezeDecision("REQUIRE_APPROVAL", approvalReasons, context.now);
  }

  return freezeDecision("ALLOW", [], context.now);
}

export function evaluatePurchase(input: unknown): AgentGuardDecision {
  const parsed = PolicyContextSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInputDecision(parsed.error);
  }

  return evaluateValidatedPurchase(parsed.data);
}

export function evaluateValidatedPolicy(context: PolicyContext): AgentGuardDecision {
  return evaluateValidatedPurchase(context);
}

export function isAgentGuardReasonCode(value: unknown): value is AgentGuardReasonCode {
  return AgentGuardReasonCodeSchema.safeParse(value).success;
}

export { AGENTGUARD_REASON_CODES };
