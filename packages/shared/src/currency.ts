import { z } from "zod";
import { DomainError } from "./errors.js";

export const SUPPORTED_CURRENCIES = ["USD"] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export const CurrencyCodeSchema = z.enum(SUPPORTED_CURRENCIES);

export function assertSupportedCurrency(value: unknown): asserts value is CurrencyCode {
  if (!CurrencyCodeSchema.safeParse(value).success) {
    throw new DomainError("INVALID_CURRENCY", `Unsupported currency: ${String(value)}`, {
      currency: value,
      supportedCurrencies: SUPPORTED_CURRENCIES,
    });
  }
}

export function isSupportedCurrency(value: unknown): value is CurrencyCode {
  return CurrencyCodeSchema.safeParse(value).success;
}

export function minorDigitsForCurrency(currency: CurrencyCode): 2 {
  assertSupportedCurrency(currency);
  return 2;
}
