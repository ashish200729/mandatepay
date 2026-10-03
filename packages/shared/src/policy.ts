import { z } from "zod";

export const POLICY_DECISIONS = ["ALLOW", "REQUIRE_APPROVAL", "BLOCK"] as const;
export const PolicyDecisionTypeSchema = z.enum(POLICY_DECISIONS);
export type PolicyDecisionType = z.infer<typeof PolicyDecisionTypeSchema>;

export const POLICY_REASON_CODES = [
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
] as const;

export const PolicyReasonCodeSchema = z.enum(POLICY_REASON_CODES);
export type PolicyReasonCode = z.infer<typeof PolicyReasonCodeSchema>;

export const PolicyDecisionSchema = z
  .object({
    decision: PolicyDecisionTypeSchema,
    reasonCodes: z.array(PolicyReasonCodeSchema),
  })
  .strict();

export type PolicyDecision = z.output<typeof PolicyDecisionSchema>;
