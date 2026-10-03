import { z } from "zod";
import { assertSupportedCurrency, type CurrencyCode } from "./currency.js";
import { DomainError, isDomainError } from "./errors.js";

declare const minorUnitsBrand: unique symbol;

/** An unsigned, safe integer representing the smallest unit of a currency. */
export type MinorUnits = number & {
  readonly [minorUnitsBrand]: "MinorUnits";
};

const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u;

export const minorUnitsSchema = z
  .number()
  .int()
  .nonnegative()
  .safe()
  .transform((value) => toMinorUnits(value));

export function isMinorUnits(value: unknown): value is MinorUnits {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function assertMinorUnits(value: unknown): asserts value is MinorUnits {
  if (!isMinorUnits(value)) {
    throw new DomainError(
      "INVALID_MONEY",
      "Money must be a non-negative safe integer minor-unit value.",
      {
        value,
      },
    );
  }
}

export function toMinorUnits(value: number): MinorUnits {
  assertMinorUnits(value);
  return value;
}

export function parseDecimalToMinorUnits(
  value: string,
  currency: CurrencyCode = "USD",
): MinorUnits {
  assertSupportedCurrency(currency);

  if (typeof value !== "string") {
    throw new DomainError("INVALID_MONEY", "Decimal money input must be a string.", { value });
  }

  const match = DECIMAL_PATTERN.exec(value);
  if (!match) {
    throw new DomainError(
      "INVALID_MONEY",
      "Decimal money must use an unsigned base-10 string with at most two fraction digits.",
      { value, currency },
    );
  }

  const wholePart = match[1];
  if (wholePart === undefined) {
    throw new DomainError("INVALID_MONEY", "Decimal money is missing its whole-number part.", {
      value,
      currency,
    });
  }
  const fractionPart = (match[2] ?? "").padEnd(2, "0");
  const minorUnits = BigInt(wholePart) * 100n + BigInt(fractionPart);

  if (minorUnits > MAX_SAFE_MINOR_UNITS) {
    throw new DomainError("MONEY_OUT_OF_RANGE", "Decimal money exceeds the safe integer range.", {
      value,
      currency,
    });
  }

  return toMinorUnits(Number(minorUnits));
}

export function formatMinorUnits(value: MinorUnits, currency: CurrencyCode = "USD"): string {
  assertSupportedCurrency(currency);
  assertMinorUnits(value);

  const minor = BigInt(value);
  const whole = minor / 100n;
  const fraction = (minor % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${fraction}`;
}

function sumMinorUnitValues(values: readonly MinorUnits[]): MinorUnits {
  let total = 0n;

  for (const value of values) {
    assertMinorUnits(value);
    total += BigInt(value);
    if (total > MAX_SAFE_MINOR_UNITS) {
      throw new DomainError(
        "MONEY_OUT_OF_RANGE",
        "Minor-unit arithmetic exceeds the safe integer range.",
        {
          values,
        },
      );
    }
  }

  return toMinorUnits(Number(total));
}

export function addMinorUnits(...values: MinorUnits[]): MinorUnits {
  return sumMinorUnitValues(values);
}

export function multiplyMinorUnits(unitPrice: MinorUnits, quantity: number): MinorUnits {
  assertMinorUnits(unitPrice);

  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new DomainError("INVALID_DOMAIN_INPUT", "Quantity must be a positive safe integer.", {
      quantity,
    });
  }

  const total = BigInt(unitPrice) * BigInt(quantity);
  if (total > MAX_SAFE_MINOR_UNITS) {
    throw new DomainError(
      "MONEY_OUT_OF_RANGE",
      "Minor-unit multiplication exceeds the safe integer range.",
      {
        unitPrice,
        quantity,
      },
    );
  }

  return toMinorUnits(Number(total));
}

export interface PurchaseTotals {
  readonly subtotal: MinorUnits;
  readonly shipping: MinorUnits;
  readonly tax: MinorUnits;
}

export function calculatePurchaseTotal(parts: PurchaseTotals): MinorUnits {
  try {
    return sumMinorUnitValues([parts.subtotal, parts.shipping, parts.tax]);
  } catch (error) {
    if (isDomainError(error) && error.code === "MONEY_OUT_OF_RANGE") {
      throw new DomainError("INVALID_TOTAL", "Purchase total exceeds the safe integer range.", {
        parts,
      });
    }
    throw error;
  }
}
