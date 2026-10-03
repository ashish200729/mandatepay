import { z } from "zod";
import {
  CanonicalMandateSchema,
  ProductConditionSchema,
  type CanonicalMandate,
} from "@mandatepay/shared";

/**
 * Every property is required for Structured Outputs. Nullable fields model
 * optional user intent without producing optional JSON Schema properties.
 */
export const MandateModelResponseSchema = z
  .object({
    status: z.enum(["ready", "needs_clarification"]),
    clarification: z.string().nullable(),
    title: z.string(),
    productIntent: z.string(),
    currency: z.literal("USD"),
    timezone: z.literal("UTC"),
    allowedBrands: z.array(z.string()),
    blockedBrands: z.array(z.string()),
    allowedCategories: z.array(z.string()),
    blockedCategories: z.array(z.string()),
    allowedConditions: z.array(ProductConditionSchema),
    transactionLimitDecimal: z.string().nullable(),
    autoSpendLimitDecimal: z.string().nullable(),
    dailyLimitDecimal: z.string().nullable(),
    weeklyLimitDecimal: z.string().nullable(),
    monthlyLimitDecimal: z.string().nullable(),
    quantityLimit: z.number().int(),
    allowedMerchants: z.array(z.string()),
    blockedMerchants: z.array(z.string()),
    newMerchantRequiresApproval: z.boolean(),
    startsAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
  })
  .strict();

export type MandateModelResponse = z.output<typeof MandateModelResponseSchema>;

export const MandateParseRequestSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(12_000)
      .refine((value) => value.trim().length > 0),
    now: z.string().datetime({ offset: false }),
  })
  .strict();

export type MandateParseRequest = z.output<typeof MandateParseRequestSchema>;

export type MandateParseResult =
  | {
      readonly status: "ready";
      readonly sourceOriginalPrompt: string;
      readonly mandate: CanonicalMandate;
    }
  | {
      readonly status: "needs_clarification";
      readonly sourceOriginalPrompt: string;
      readonly clarification: string;
      readonly mandate: null;
    };

export { CanonicalMandateSchema };
