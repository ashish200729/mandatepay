import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";
import { calculatePurchaseTotal, minorUnitsSchema } from "./money.js";

export const PRODUCT_CONDITIONS = ["NEW", "USED", "REFURBISHED"] as const;

export const ProductConditionSchema = z.enum(PRODUCT_CONDITIONS);
export type ProductCondition = z.infer<typeof ProductConditionSchema>;

const utcDateTimeSchema = z.string().datetime({ offset: false });
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonEmptyStringSchema = z.string().trim().min(1);
const stringListSchema = z.array(nonEmptyStringSchema).default([]);

function hasDuplicateValues(values: readonly string[]): boolean {
  const normalized = values.map((value) => value.toLocaleLowerCase("en-US"));
  return new Set(normalized).size !== normalized.length;
}

function hasOverlap(left: readonly string[], right: readonly string[]): boolean {
  const rightValues = new Set(right.map((value) => value.toLocaleLowerCase("en-US")));
  return left.some((value) => rightValues.has(value.toLocaleLowerCase("en-US")));
}

const listWithUniqueValuesSchema = stringListSchema.refine(
  (values) => !hasDuplicateValues(values),
  "Lists must not contain duplicate values.",
);

export const CanonicalMandateSchema = z
  .object({
    title: nonEmptyStringSchema,
    productIntent: nonEmptyStringSchema,
    currency: CurrencyCodeSchema,
    timezone: z.literal("UTC"),
    allowedBrands: listWithUniqueValuesSchema,
    blockedBrands: listWithUniqueValuesSchema,
    allowedCategories: listWithUniqueValuesSchema,
    blockedCategories: listWithUniqueValuesSchema,
    allowedConditions: z
      .array(ProductConditionSchema)
      .min(1)
      .refine(
        (values) => new Set(values).size === values.length,
        "Allowed conditions must not contain duplicates.",
      ),
    autoSpendLimit: minorUnitsSchema,
    transactionLimit: minorUnitsSchema.refine(
      (value) => value > 0,
      "Transaction limit must be greater than zero.",
    ),
    dailyLimit: minorUnitsSchema
      .optional()
      .refine(
        (value) => value === undefined || value > 0,
        "Daily limit must be greater than zero when provided.",
      ),
    weeklyLimit: minorUnitsSchema
      .optional()
      .refine(
        (value) => value === undefined || value > 0,
        "Weekly limit must be greater than zero when provided.",
      ),
    monthlyLimit: minorUnitsSchema
      .optional()
      .refine(
        (value) => value === undefined || value > 0,
        "Monthly limit must be greater than zero when provided.",
      ),
    quantityLimit: positiveSafeIntegerSchema.default(1),
    allowedMerchants: listWithUniqueValuesSchema,
    blockedMerchants: listWithUniqueValuesSchema,
    newMerchantRequiresApproval: z.boolean(),
    startsAt: utcDateTimeSchema.optional(),
    expiresAt: utcDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((mandate, context) => {
    if (mandate.autoSpendLimit > mandate.transactionLimit) {
      context.addIssue({
        code: "custom",
        path: ["autoSpendLimit"],
        message: "Automatic spending limit cannot exceed the transaction limit.",
      });
    }

    if (mandate.startsAt && mandate.expiresAt) {
      const startsAt = Date.parse(mandate.startsAt);
      const expiresAt = Date.parse(mandate.expiresAt);

      if (startsAt >= expiresAt) {
        context.addIssue({
          code: "custom",
          path: ["expiresAt"],
          message: "Expiration must be after the start time.",
        });
      }
    }

    const listPairs = [
      ["allowedBrands", mandate.allowedBrands, mandate.blockedBrands],
      ["allowedCategories", mandate.allowedCategories, mandate.blockedCategories],
      ["allowedMerchants", mandate.allowedMerchants, mandate.blockedMerchants],
    ] as const;

    for (const [field, allowedValues, blockedValues] of listPairs) {
      if (hasOverlap(allowedValues, blockedValues)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Allowed and blocked ${field.replace("allowed", "").toLowerCase()} values cannot overlap.`,
        });
      }
    }
  });

export type CanonicalMandate = z.output<typeof CanonicalMandateSchema>;
export type CanonicalMandateInput = z.input<typeof CanonicalMandateSchema>;

export const PurchaseProposalSchema = z
  .object({
    mandateId: nonEmptyStringSchema,
    productSnapshotId: nonEmptyStringSchema,
    quantity: positiveSafeIntegerSchema,
    subtotal: minorUnitsSchema,
    shipping: minorUnitsSchema,
    tax: minorUnitsSchema,
    total: minorUnitsSchema,
    currency: CurrencyCodeSchema,
    idempotencyKey: nonEmptyStringSchema,
  })
  .strict()
  .superRefine((proposal, context) => {
    let expectedTotal: typeof proposal.total;
    try {
      expectedTotal = calculatePurchaseTotal({
        subtotal: proposal.subtotal,
        shipping: proposal.shipping,
        tax: proposal.tax,
      });
    } catch {
      context.addIssue({
        code: "custom",
        path: ["total"],
        message: "Purchase total exceeds the safe integer range.",
      });
      return;
    }

    if (expectedTotal !== proposal.total) {
      context.addIssue({
        code: "custom",
        path: ["total"],
        message: "Total must equal subtotal plus shipping plus tax.",
      });
    }
  });

export type PurchaseProposal = z.output<typeof PurchaseProposalSchema>;
export type PurchaseProposalInput = z.input<typeof PurchaseProposalSchema>;

export const RefundKindSchema = z.enum(["FULL", "PARTIAL"]);
export type RefundKind = z.infer<typeof RefundKindSchema>;

export const RefundRequestSchema = z
  .object({
    paymentId: nonEmptyStringSchema,
    amount: minorUnitsSchema.refine(
      (value) => value > 0,
      "Refund amount must be greater than zero.",
    ),
    currency: CurrencyCodeSchema,
    reason: nonEmptyStringSchema,
    kind: RefundKindSchema,
  })
  .strict();

export type RefundRequest = z.output<typeof RefundRequestSchema>;
export type RefundRequestInput = z.input<typeof RefundRequestSchema>;
