import { CurrencyCodeSchema, minorUnitsSchema, type MinorUnits } from "@mandatepay/shared";
import { z } from "zod";
import { PayPalInputError, PayPalResponseError, PayPalWebhookError } from "./errors.js";

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(38)
  .regex(/^[\x21-\x7E]+$/u);
export const sandboxRedirectUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    if (parsed.username.length > 0 || parsed.password.length > 0) return false;
    return (
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))
    );
  });
const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" && parsed.username.length === 0 && parsed.password.length === 0
    );
  });
const providerDecimalSchema = z.string().regex(/^\d+\.\d{2}$/u);
const providerMoneySchema = z
  .object({
    currency_code: z.literal("USD"),
    value: providerDecimalSchema,
  })
  .strict();

/**
 * Order amounts echo the breakdown sent with line items (item_total, shipping, tax_total, ...).
 * Each breakdown entry is validated as provider money; only currency and value are authoritative.
 */
const orderAmountSchema = z
  .object({
    currency_code: z.literal("USD"),
    value: providerDecimalSchema,
    breakdown: z.record(z.string(), providerMoneySchema).optional(),
  })
  .strict();

export const linkSchema = z
  .object({
    href: z.string().url(),
    rel: z.string().min(1),
    method: z.string().optional(),
  })
  .passthrough();

export const orderItemSchema = z
  .object({
    name: z.string().trim().min(1).max(127),
    sku: z.string().trim().min(1).max(127).optional(),
    quantity: z.number().int().positive().max(999),
    unitAmountMinor: minorUnitsSchema,
  })
  .strict();

export const CreateOrderInputSchema = z
  .object({
    amountMinor: minorUnitsSchema.refine((value) => value > 0),
    referenceId: z.string().trim().min(1).max(127),
    customId: z.string().trim().min(1).max(127),
    requestId: idempotencyKeySchema,
    returnUrl: sandboxRedirectUrlSchema,
    cancelUrl: sandboxRedirectUrlSchema,
    /** Line items shown to the buyer. When present, the breakdown must sum exactly. */
    items: z.array(orderItemSchema).min(1).max(10).optional(),
    shippingMinor: minorUnitsSchema.optional(),
    taxMinor: minorUnitsSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => refineOrderBreakdown(input, context));

/** Line items, shipping and tax must sum exactly to the order amount. */
export function refineOrderBreakdown(
  input: {
    amountMinor: number;
    items?: readonly { unitAmountMinor: number; quantity: number }[] | undefined;
    shippingMinor?: number | undefined;
    taxMinor?: number | undefined;
  },
  context: z.RefinementCtx,
) {
  if (!input.items) {
    if (input.shippingMinor !== undefined || input.taxMinor !== undefined) {
      context.addIssue({ code: "custom", path: ["items"], message: "Breakdown needs items." });
    }
    return;
  }
  const itemTotal = input.items.reduce(
    (total, item) => total + item.unitAmountMinor * item.quantity,
    0,
  );
  const total = itemTotal + (input.shippingMinor ?? 0) + (input.taxMinor ?? 0);
  if (!Number.isSafeInteger(itemTotal) || total !== input.amountMinor) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "Item, shipping and tax amounts must equal the order amount.",
    });
  }
}

export type CreateOrderInput = z.output<typeof CreateOrderInputSchema>;

export const OrderIdSchema = z.string().trim().min(1);

export const PAYPAL_CAPTURE_STATUSES = [
  "COMPLETED",
  "DECLINED",
  "PENDING",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "FAILED",
] as const;

/** PENDING/DECLINED captures carry a reason code that must not be discarded. */
const captureStatusDetailsSchema = z
  .object({ reason: z.string().trim().min(1).max(128).optional() })
  .passthrough();

const orderCaptureSchema = z
  .object({
    id: z.string().trim().min(1),
    status: z.enum(PAYPAL_CAPTURE_STATUSES),
    status_details: captureStatusDetailsSchema.optional(),
    amount: providerMoneySchema,
    custom_id: z.string().trim().min(1).optional(),
    create_time: z.string().trim().min(1).optional(),
  })
  .passthrough();

export const PayPalOrderSchema = z
  .object({
    id: OrderIdSchema,
    status: z.enum([
      "CREATED",
      "SAVED",
      "APPROVED",
      "VOIDED",
      "COMPLETED",
      "PAYER_ACTION_REQUIRED",
    ]),
    links: z.array(linkSchema),
    purchase_units: z
      .array(
        z
          .object({
            reference_id: z.string().optional(),
            custom_id: z.string().optional(),
            amount: orderAmountSchema.optional(),
            payments: z
              .object({ captures: z.array(orderCaptureSchema).optional() })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type PayPalOrder = z.output<typeof PayPalOrderSchema> & {
  /** The validated buyer redirect (rel "approve" or "payer-action"), if any. */
  readonly approvalUrl: string | null;
};

export const PayPalCaptureSchema = z
  .object({
    id: z.string().trim().min(1),
    status: z.enum(PAYPAL_CAPTURE_STATUSES),
    status_details: captureStatusDetailsSchema.optional(),
    amount: providerMoneySchema,
    custom_id: z.string().trim().min(1).optional(),
    create_time: z.string().trim().min(1).optional(),
  })
  .passthrough();

export type PayPalCapture = z.output<typeof PayPalCaptureSchema>;

export const RefundCaptureInputSchema = z
  .object({
    captureId: z.string().trim().min(1),
    requestId: idempotencyKeySchema,
    amountMinor: minorUnitsSchema.nullable(),
    invoiceId: z.string().trim().min(1).max(127).nullable().default(null),
    reason: z.string().trim().min(1).max(255).nullable().default(null),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.amountMinor !== null && input.amountMinor <= 0) {
      context.addIssue({
        code: "custom",
        path: ["amountMinor"],
        message: "Partial refund must be positive.",
      });
    }
  });

export type RefundCaptureInput = z.output<typeof RefundCaptureInputSchema>;

export const PayPalRefundSchema = z
  .object({
    id: z.string().trim().min(1),
    status: z.enum(["COMPLETED", "PENDING", "FAILED", "CANCELLED"]),
    amount: providerMoneySchema,
    invoice_id: z.string().trim().min(1).optional(),
    capture_id: z.string().trim().min(1).optional(),
    create_time: z.string().trim().min(1).optional(),
  })
  .passthrough();

export type PayPalRefund = z.output<typeof PayPalRefundSchema>;

export const WebhookHeadersSchema = z
  .object({
    transmissionId: z.string().trim().min(1),
    transmissionTime: z.string().trim().min(1),
    certUrl: httpsUrlSchema,
    authAlgo: z.string().trim().min(1),
    transmissionSig: z.string().trim().min(1),
  })
  .strict();

export type WebhookHeaders = z.output<typeof WebhookHeadersSchema>;

export const VerifyWebhookInputSchema = z
  .object({
    rawBody: z.string().min(2),
    headers: WebhookHeadersSchema,
  })
  .strict();

export type VerifyWebhookInput = z.output<typeof VerifyWebhookInputSchema>;

export const WebhookVerificationResponseSchema = z
  .object({
    verification_status: z.enum(["SUCCESS", "FAILURE"]),
  })
  .strict();

export type WebhookVerificationResponse = z.output<typeof WebhookVerificationResponseSchema>;

export function parseProviderMoney(value: unknown): MinorUnits {
  // An order amount may carry a validated breakdown; the total is its currency and value.
  let total = value;
  if (typeof value === "object" && value !== null && "breakdown" in value) {
    const amount = orderAmountSchema.safeParse(value);
    total = amount.success
      ? { currency_code: amount.data.currency_code, value: amount.data.value }
      : null;
  }
  const parsed = providerMoneySchema.safeParse(total);
  if (!parsed.success) throw new PayPalResponseError("INVALID_ORDER_RESPONSE");
  const whole = parsed.data.value;
  const units = Number(whole.replace(".", ""));
  const result = minorUnitsSchema.safeParse(units);
  if (!result.success) throw new PayPalResponseError("INVALID_ORDER_RESPONSE");
  return result.data;
}

export function parseCreateOrderInput(input: unknown): CreateOrderInput {
  const parsed = CreateOrderInputSchema.safeParse(input);
  if (!parsed.success) throw new PayPalInputError("INVALID_ORDER_INPUT");
  return parsed.data;
}

export function parseRefundInput(input: unknown): RefundCaptureInput {
  const parsed = RefundCaptureInputSchema.safeParse(input);
  if (!parsed.success) throw new PayPalInputError("INVALID_REFUND_INPUT");
  return parsed.data;
}

export function parseVerifyWebhookInput(input: unknown): VerifyWebhookInput {
  const parsed = VerifyWebhookInputSchema.safeParse(input);
  if (!parsed.success) throw new PayPalWebhookError("INVALID_WEBHOOK_INPUT");
  return parsed.data;
}

export { CurrencyCodeSchema };
