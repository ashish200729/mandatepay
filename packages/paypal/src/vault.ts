import { minorUnitsSchema } from "@mandatepay/shared";
import { z } from "zod";
import { PayPalInputError, PayPalResponseError } from "./errors.js";
import {
  idempotencyKeySchema,
  linkSchema,
  orderItemSchema,
  refineOrderBreakdown,
  sandboxRedirectUrlSchema,
} from "./types.js";

/**
 * PayPal Vault v3 identifiers (setup tokens, payment tokens, customers) are
 * short opaque strings. They are validated before being placed in a URL path.
 */
export const VaultIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,128}$/u);

export const CreateVaultSetupTokenInputSchema = z
  .object({
    requestId: idempotencyKeySchema,
    returnUrl: sandboxRedirectUrlSchema,
    cancelUrl: sandboxRedirectUrlSchema,
    /** Shown to the buyer on the PayPal consent screen. */
    description: z.string().trim().min(1).max(127).default("MandatePay autonomous purchases"),
  })
  .strict();

export type CreateVaultSetupTokenInput = z.input<typeof CreateVaultSetupTokenInputSchema>;

export const CreateVaultPaymentTokenInputSchema = z
  .object({
    setupTokenId: VaultIdSchema,
    requestId: idempotencyKeySchema,
  })
  .strict();

export type CreateVaultPaymentTokenInput = z.input<typeof CreateVaultPaymentTokenInputSchema>;

/** A buyer-not-present order charged to a saved Vault payment token. */
export const CreateVaultOrderInputSchema = z
  .object({
    amountMinor: minorUnitsSchema.refine((value) => value > 0),
    referenceId: z.string().trim().min(1).max(127),
    customId: z.string().trim().min(1).max(127),
    requestId: idempotencyKeySchema,
    vaultId: VaultIdSchema,
    items: z.array(orderItemSchema).min(1).max(10).optional(),
    shippingMinor: minorUnitsSchema.optional(),
    taxMinor: minorUnitsSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => refineOrderBreakdown(input, context));

export type CreateVaultOrderInput = z.output<typeof CreateVaultOrderInputSchema>;

export const PayPalVaultSetupTokenResponseSchema = z
  .object({
    id: VaultIdSchema,
    status: z.string().trim().min(1).max(64),
    customer: z
      .object({ id: z.string().trim().min(1).max(255) })
      .passthrough()
      .optional(),
    links: z.array(linkSchema).optional(),
  })
  .passthrough();

export const PayPalVaultPaymentTokenResponseSchema = z
  .object({
    id: VaultIdSchema,
    customer: z
      .object({ id: z.string().trim().min(1).max(255) })
      .passthrough()
      .optional(),
    payment_source: z
      .object({
        paypal: z
          .object({ email_address: z.string().trim().min(3).max(320).optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface PayPalVaultSetupToken {
  readonly id: string;
  readonly status: string;
  readonly customerId: string | null;
  /** Validated buyer redirect (rel "approve"); null once the buyer acted. */
  readonly approvalUrl: string | null;
}

export interface PayPalVaultPaymentToken {
  /** The payment token id. Secret-like: store encrypted, never log or return to a browser. */
  readonly id: string;
  readonly customerId: string | null;
  readonly payerEmail: string | null;
}

export interface PayPalVaultDeletion {
  /** PayPal reported the token was already gone (404); still counts as removed. */
  readonly alreadyAbsent: boolean;
}

export function parseVaultInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new PayPalInputError("INVALID_VAULT_INPUT");
  return parsed.data;
}

export function parseVaultId(value: string): string {
  const parsed = VaultIdSchema.safeParse(value);
  if (!parsed.success) throw new PayPalInputError("INVALID_VAULT_INPUT");
  return parsed.data;
}

const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/u;

function customerId(value: { id: string } | undefined): string | null {
  return value && CUSTOMER_ID_PATTERN.test(value.id) ? value.id : null;
}

export function parseSetupTokenResponse(
  payload: unknown,
  approvalHosts: readonly string[],
): PayPalVaultSetupToken {
  const parsed = PayPalVaultSetupTokenResponseSchema.safeParse(payload);
  if (!parsed.success) throw new PayPalResponseError("INVALID_VAULT_RESPONSE");
  const href = parsed.data.links?.find((link) => link.rel === "approve")?.href ?? null;
  let approvalUrl: string | null = null;
  if (href !== null) {
    try {
      const url = new URL(href);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        href.length > 2048 ||
        !approvalHosts.includes(url.hostname)
      )
        throw new Error("invalid approval host");
      approvalUrl = href;
    } catch {
      throw new PayPalResponseError("INVALID_APPROVAL_URL");
    }
  }
  if (parsed.data.status === "PAYER_ACTION_REQUIRED" && approvalUrl === null) {
    throw new PayPalResponseError("INVALID_APPROVAL_URL");
  }
  return Object.freeze({
    id: parsed.data.id,
    status: parsed.data.status,
    customerId: customerId(parsed.data.customer),
    approvalUrl,
  });
}

export function parsePaymentTokenResponse(payload: unknown): PayPalVaultPaymentToken {
  const parsed = PayPalVaultPaymentTokenResponseSchema.safeParse(payload);
  if (!parsed.success) throw new PayPalResponseError("INVALID_VAULT_RESPONSE");
  const email = parsed.data.payment_source?.paypal?.email_address ?? null;
  return Object.freeze({
    id: parsed.data.id,
    customerId: customerId(parsed.data.customer),
    payerEmail: email && /^[^\s@]+@[^\s@]+$/u.test(email) ? email : null,
  });
}
