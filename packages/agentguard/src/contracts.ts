import { z } from "zod";
import {
  CanonicalMandateSchema,
  CurrencyCodeSchema,
  MANDATE_STATUSES,
  POLICY_DECISIONS,
  POLICY_REASON_CODES,
  ProductConditionSchema,
  type CurrencyCode,
  type MinorUnits,
  type PolicyReasonCode,
  type ProductCondition,
} from "@mandatepay/shared";
import { minorUnitsSchema } from "@mandatepay/shared";

export const AGENTGUARD_EXTRA_REASON_CODES = [
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
] as const;

export const AGENTGUARD_REASON_CODES = [
  ...POLICY_REASON_CODES,
  ...AGENTGUARD_EXTRA_REASON_CODES,
] as const;

export const AgentGuardReasonCodeSchema = z.enum(AGENTGUARD_REASON_CODES);
export type AgentGuardReasonCode = z.infer<typeof AgentGuardReasonCodeSchema>;

export const UtcDateTimeSchema = z.string().datetime({ offset: false });

export const SpendWindowSchema = z.enum(["DAILY", "WEEKLY", "MONTHLY"]);
export type SpendWindow = z.infer<typeof SpendWindowSchema>;

export const SpendPeriodSchema = z
  .object({
    startAt: UtcDateTimeSchema,
    endAt: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((period, context) => {
    if (Date.parse(period.startAt) >= Date.parse(period.endAt)) {
      context.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "A UTC spend period must end after it starts.",
      });
    }
  });

export type SpendPeriod = z.output<typeof SpendPeriodSchema>;

export const SpendReservationSchema = z
  .object({
    id: z.string().trim().min(1),
    amount: minorUnitsSchema,
    currency: CurrencyCodeSchema,
    windows: z
      .array(SpendWindowSchema)
      .min(1)
      .refine(
        (windows) => new Set(windows).size === windows.length,
        "Reservation windows must be unique.",
      ),
  })
  .strict();

export type SpendReservation = z.output<typeof SpendReservationSchema>;

const confirmedSpendSchema = z
  .object({
    daily: minorUnitsSchema,
    weekly: minorUnitsSchema,
    monthly: minorUnitsSchema,
  })
  .strict();

export const SpendContextSchema = z
  .object({
    currency: CurrencyCodeSchema,
    confirmed: confirmedSpendSchema,
    periods: z
      .object({
        daily: SpendPeriodSchema,
        weekly: SpendPeriodSchema,
        monthly: SpendPeriodSchema,
      })
      .strict(),
    /** Active reservations for this mandate, excluding the proposal being evaluated. */
    otherReservations: z.array(SpendReservationSchema).default([]),
  })
  .strict();

export type SpendContext = z.output<typeof SpendContextSchema>;

export const ProductFactsSchema = z
  .object({
    snapshotId: z.string().trim().min(1),
    brand: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    condition: ProductConditionSchema,
    merchantId: z.string().trim().min(1),
    merchant: z.string().trim().min(1),
    isNewMerchant: z.boolean().optional(),
    unitPrice: minorUnitsSchema,
    currency: CurrencyCodeSchema,
    quantity: z.number().int().positive().safe(),
  })
  .strict();

export type ProductFacts = z.output<typeof ProductFactsSchema>;

const proposalForEvaluationSchema = z
  .object({
    mandateId: z.string().trim().min(1),
    mandateVersion: z.number().int().positive().safe(),
    productSnapshotId: z.string().trim().min(1),
    quantity: z.number().int().positive().safe(),
    subtotal: minorUnitsSchema,
    shipping: minorUnitsSchema,
    tax: minorUnitsSchema,
    total: minorUnitsSchema,
    currency: CurrencyCodeSchema,
    idempotencyKey: z.string().trim().min(1),
  })
  .strict();

export type ProposalForEvaluation = z.output<typeof proposalForEvaluationSchema>;

const mandateContextSchema = z
  .object({
    id: z.string().trim().min(1),
    version: z.number().int().positive().safe(),
    status: z.enum(MANDATE_STATUSES),
    rules: CanonicalMandateSchema,
  })
  .strict();

export type MandatePolicyContext = z.output<typeof mandateContextSchema>;

export const PolicyContextSchema = z
  .object({
    now: UtcDateTimeSchema,
    mandate: mandateContextSchema,
    proposal: proposalForEvaluationSchema,
    product: ProductFactsSchema,
    spend: SpendContextSchema,
    globalAutonomousPurchasingEnabled: z.boolean(),
  })
  .strict();

export type PolicyContext = z.output<typeof PolicyContextSchema>;

export const AgentGuardDecisionSchema = z
  .object({
    decision: z.enum(POLICY_DECISIONS),
    reasonCodes: z.array(AgentGuardReasonCodeSchema),
    evaluatedAt: UtcDateTimeSchema.nullable(),
    validationIssues: z.array(z.string()),
  })
  .strict();

type AgentGuardDecisionShape = z.output<typeof AgentGuardDecisionSchema>;
export type AgentGuardDecision = Omit<
  AgentGuardDecisionShape,
  "reasonCodes" | "validationIssues"
> & {
  readonly reasonCodes: readonly AgentGuardReasonCode[];
  readonly validationIssues: readonly string[];
};

export interface SpendTotals {
  readonly daily: MinorUnits;
  readonly weekly: MinorUnits;
  readonly monthly: MinorUnits;
}

export type SharedPolicyReasonCode = PolicyReasonCode;
export type SharedPolicyDecision = (typeof POLICY_DECISIONS)[number];
export type SharedCurrencyCode = CurrencyCode;
export type SharedProductCondition = ProductCondition;
