import {
  CanonicalMandateSchema,
  type CanonicalMandate,
  type CanonicalMandateInput,
} from "@mandatepay/shared";
import {
  DatabaseError,
  type DatabaseClient,
  MandateRuleType,
  MandateRepository,
  RuleOperator,
  type CreateMandateInput,
  type MandateRuleInput,
  type MandateStatus,
} from "@mandatepay/database";

export type DraftParser = (
  request: { prompt: string; now: string },
  userId?: string,
) => Promise<unknown>;

export type MandateDTO = {
  id: string;
  title: string;
  status: MandateStatus;
  version: number;
  rules: CanonicalMandate;
  originalPrompt: string;
  currency: string;
  startsAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ClarificationResult = {
  status: "needs_clarification";
  sourceOriginalPrompt: string;
  clarification: string;
  mandate: null;
};

export type ReviewResult = {
  status: "ready";
  sourceOriginalPrompt: string;
  mandate: CanonicalMandate;
};

type MandateRecord = {
  id: string;
  title: string;
  status: MandateStatus;
  version: number;
  originalPrompt: string;
  currency: string;
  startsAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  autoSpendLimit: bigint;
  transactionLimit: bigint;
  dailyLimit: bigint | null;
  weeklyLimit: bigint | null;
  monthlyLimit: bigint | null;
  activeVersion?: { canonicalRules: unknown } | null;
  versions?: Array<{ canonicalRules: unknown }>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseCanonicalMandate(value: unknown): CanonicalMandate {
  const parsed = CanonicalMandateSchema.safeParse(value);
  if (!parsed.success) {
    throw new DatabaseError("INVALID_DOMAIN_INPUT", "Mandate draft is not valid.");
  }
  return parsed.data;
}

export function normalizeDraftResult(
  value: unknown,
  sourceOriginalPrompt: string,
): ReviewResult | ClarificationResult {
  const object = record(value);
  if (
    object?.status === "clarification" ||
    object?.status === "needs_clarification" ||
    object?.kind === "clarification"
  ) {
    const questions = Array.isArray(object.questions)
      ? object.questions.filter((question): question is string => typeof question === "string")
      : [];
    return {
      status: "needs_clarification",
      sourceOriginalPrompt,
      clarification:
        (typeof object.clarification === "string" ? object.clarification : "") ||
        questions.slice(0, 5).join(" ") ||
        "Please clarify your purchasing requirements.",
      mandate: null,
    };
  }
  const candidate = object?.mandate ?? value;
  return { status: "ready", sourceOriginalPrompt, mandate: parseCanonicalMandate(candidate) };
}

function addRule(
  rules: MandateRuleInput[],
  ruleType: MandateRuleType,
  operator: RuleOperator,
  value: readonly string[],
) {
  if (value.length) rules.push({ ruleType, operator, value: [...value] });
}

function toDate(value: string | undefined, fallback: Date): Date {
  const date = value ? new Date(value) : fallback;
  if (Number.isNaN(date.getTime())) {
    throw new DatabaseError("INVALID_DATE_RANGE", "Mandate validity dates are invalid.");
  }
  return date;
}

export function canonicalToCreateInput(
  userId: string,
  originalPrompt: string,
  canonical: CanonicalMandate,
  creationRequestKey?: string | null,
): CreateMandateInput {
  const startsAt = toDate(canonical.startsAt, new Date());
  const defaultExpiry = new Date(startsAt.getTime() + 24 * 60 * 60 * 1000);
  const expiresAt = toDate(canonical.expiresAt, defaultExpiry);
  if (expiresAt <= startsAt) {
    throw new DatabaseError("INVALID_DATE_RANGE", "Mandate expiration must be after its start.");
  }

  const rules: MandateRuleInput[] = [];
  addRule(rules, MandateRuleType.ALLOWED_BRAND, RuleOperator.IN, canonical.allowedBrands);
  addRule(rules, MandateRuleType.BLOCKED_BRAND, RuleOperator.IN, canonical.blockedBrands);
  addRule(rules, MandateRuleType.ALLOWED_CATEGORY, RuleOperator.IN, canonical.allowedCategories);
  addRule(rules, MandateRuleType.BLOCKED_CATEGORY, RuleOperator.IN, canonical.blockedCategories);
  addRule(rules, MandateRuleType.ALLOWED_MERCHANT, RuleOperator.IN, canonical.allowedMerchants);
  addRule(rules, MandateRuleType.BLOCKED_MERCHANT, RuleOperator.IN, canonical.blockedMerchants);
  addRule(rules, MandateRuleType.REQUIRED_CONDITION, RuleOperator.IN, canonical.allowedConditions);

  const boundCanonical: CanonicalMandateInput = {
    ...canonical,
    startsAt: startsAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  return {
    userId,
    title: canonical.title,
    productIntent: canonical.productIntent,
    originalPrompt,
    currency: canonical.currency,
    autoSpendLimit: BigInt(canonical.autoSpendLimit),
    transactionLimit: BigInt(canonical.transactionLimit),
    dailyLimit: canonical.dailyLimit === undefined ? null : BigInt(canonical.dailyLimit),
    weeklyLimit: canonical.weeklyLimit === undefined ? null : BigInt(canonical.weeklyLimit),
    monthlyLimit: canonical.monthlyLimit === undefined ? null : BigInt(canonical.monthlyLimit),
    spendTimeZone: canonical.timezone,
    startsAt,
    expiresAt,
    canonicalRules: boundCanonical,
    rules,
    status: "DRAFT",
    creationRequestKey: creationRequestKey ?? null,
  };
}

export function toMandateDTO(mandate: MandateRecord): MandateDTO {
  const version = mandate.activeVersion ?? mandate.versions?.[0];
  const parsed = CanonicalMandateSchema.safeParse(version?.canonicalRules);
  if (!version || !parsed.success) {
    throw new DatabaseError("INVALID_STATE", "Mandate canonical snapshot is invalid.");
  }
  const rules = parsed.data;
  return {
    id: mandate.id,
    title: mandate.title,
    status: mandate.status,
    version: mandate.version,
    rules,
    originalPrompt: mandate.originalPrompt,
    currency: mandate.currency,
    startsAt: mandate.startsAt.toISOString(),
    expiresAt: mandate.expiresAt.toISOString(),
    createdAt: mandate.createdAt.toISOString(),
    updatedAt: mandate.updatedAt.toISOString(),
  };
}

export function mandateRepository(database: DatabaseClient) {
  return new MandateRepository(database);
}
