import { z } from "zod";
import { PayPalConfigurationError } from "./errors.js";

export const PAYPAL_ENVIRONMENT_NAMES = ["sandbox", "live"] as const;
export type PayPalEnvironmentName = (typeof PAYPAL_ENVIRONMENT_NAMES)[number];

export interface PayPalEnvironmentHosts {
  /** REST API origin used for every server-side request. */
  readonly apiBaseUrl: string;
  /** Buyer-facing hosts allowed for approve/payer-action redirects. */
  readonly approvalHosts: readonly string[];
  /** The canonical buyer-facing host used to build a checkout URL. */
  readonly checkoutHost: string;
  /** API hosts accepted when extracting IDs from provider resource links. */
  readonly resourceLinkHosts: readonly string[];
}

/**
 * The only place that maps PAYPAL_ENV to provider hosts. Sandbox keeps the
 * previously accepted hosts unchanged; live is an explicit opt-in.
 */
export const PAYPAL_ENVIRONMENTS: Readonly<Record<PayPalEnvironmentName, PayPalEnvironmentHosts>> =
  Object.freeze({
    sandbox: Object.freeze({
      apiBaseUrl: "https://api-m.sandbox.paypal.com",
      approvalHosts: Object.freeze(["www.sandbox.paypal.com", "sandbox.paypal.com"]),
      checkoutHost: "www.sandbox.paypal.com",
      resourceLinkHosts: Object.freeze(["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"]),
    }),
    live: Object.freeze({
      apiBaseUrl: "https://api-m.paypal.com",
      approvalHosts: Object.freeze(["www.paypal.com"]),
      checkoutHost: "www.paypal.com",
      resourceLinkHosts: Object.freeze(["api-m.paypal.com", "api.paypal.com"]),
    }),
  });

/** Kept for existing imports; equals the Sandbox API origin. */
export const PAYPAL_SANDBOX_BASE_URL = PAYPAL_ENVIRONMENTS.sandbox.apiBaseUrl;

export function paypalEnvironmentHosts(environment: PayPalEnvironmentName): PayPalEnvironmentHosts {
  return PAYPAL_ENVIRONMENTS[environment];
}

/** Every buyer-facing approval host across environments (browser-side validation). */
export const PAYPAL_BUYER_APPROVAL_HOSTS = Object.freeze([
  PAYPAL_ENVIRONMENTS.sandbox.checkoutHost,
  PAYPAL_ENVIRONMENTS.live.checkoutHost,
]);

export const PayPalConfigSchema = z
  .object({
    environment: z.enum(PAYPAL_ENVIRONMENT_NAMES).default("sandbox"),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
    webhookId: z.string().trim().min(1).nullable().default(null),
    timeoutMs: z.number().int().positive().max(120_000).default(15_000),
    maxRetries: z.number().int().nonnegative().max(5).default(2),
  })
  .strict();

export type PayPalConfig = z.output<typeof PayPalConfigSchema>;

export function parsePayPalConfig(input: unknown): PayPalConfig {
  const parsed = PayPalConfigSchema.safeParse(input);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path[0];
    switch (path) {
      case "environment":
        throw new PayPalConfigurationError("INVALID_ENVIRONMENT");
      case "clientId":
        throw new PayPalConfigurationError("MISSING_CLIENT_ID");
      case "clientSecret":
        throw new PayPalConfigurationError("MISSING_CLIENT_SECRET");
      case "timeoutMs":
        throw new PayPalConfigurationError("INVALID_TIMEOUT");
      case "maxRetries":
        throw new PayPalConfigurationError("INVALID_RETRY_LIMIT");
      case "webhookId":
        throw new PayPalConfigurationError("MISSING_WEBHOOK_ID");
      default:
        throw new PayPalConfigurationError("INVALID_ENVIRONMENT");
    }
  }
  return parsed.data;
}

export function loadPayPalConfig(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  return parsePayPalConfig({
    environment: env.PAYPAL_ENV?.trim() || undefined,
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    webhookId: env.PAYPAL_WEBHOOK_ID?.trim() || null,
    timeoutMs: env.PAYPAL_TIMEOUT_MS === undefined ? undefined : Number(env.PAYPAL_TIMEOUT_MS),
    maxRetries: env.PAYPAL_MAX_RETRIES === undefined ? undefined : Number(env.PAYPAL_MAX_RETRIES),
  });
}
