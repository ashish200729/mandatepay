import { z } from "zod";
import { PayPalConfigurationError } from "./errors.js";

export const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

export const PayPalConfigSchema = z
  .object({
    environment: z.literal("sandbox"),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
    webhookId: z.string().trim().min(1).nullable().default(null),
    timeoutMs: z.number().int().positive().max(120_000).default(15_000),
    maxRetries: z.number().int().nonnegative().max(1).default(0),
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
    environment: env.PAYPAL_ENV,
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    webhookId: env.PAYPAL_WEBHOOK_ID?.trim() || null,
    timeoutMs: env.PAYPAL_TIMEOUT_MS === undefined ? undefined : Number(env.PAYPAL_TIMEOUT_MS),
    maxRetries: env.PAYPAL_MAX_RETRIES === undefined ? undefined : Number(env.PAYPAL_MAX_RETRIES),
  });
}
