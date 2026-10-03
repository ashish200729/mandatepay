import { DatabaseError } from "./errors.js";

export const SUPPORTED_CURRENCY = "USD" as const;
export const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

export function assertCurrency(currency: string): asserts currency is typeof SUPPORTED_CURRENCY {
  if (currency !== SUPPORTED_CURRENCY) {
    throw new DatabaseError(
      "INVALID_CURRENCY",
      `Only ${SUPPORTED_CURRENCY} is supported by the MVP database layer.`,
      { currency },
    );
  }
}

export function assertMinorUnits(value: bigint, field = "amount"): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new DatabaseError("INVALID_MONEY", `${field} must be a non-negative bigint.`, {
      field,
    });
  }

  if (value > MAX_SAFE_MINOR_UNITS) {
    throw new DatabaseError("INVALID_MONEY", `${field} exceeds the supported monetary range.`, {
      field,
    });
  }
}

export function assertPositiveMinorUnits(value: bigint, field = "amount"): void {
  assertMinorUnits(value, field);
  if (value === 0n) {
    throw new DatabaseError("INVALID_MONEY", `${field} must be greater than zero.`, { field });
  }
}

export function assertOptionalMinorUnits(value: bigint | null | undefined, field: string): void {
  if (value !== null && value !== undefined) {
    assertMinorUnits(value, field);
  }
}

export function assertDateRange(start: Date, end: Date, field = "date range"): void {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new DatabaseError("INVALID_DATE_RANGE", `${field} start must be a valid date.`);
  }
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
    throw new DatabaseError("INVALID_DATE_RANGE", `${field} end must be a valid date.`);
  }
  if (end <= start) {
    throw new DatabaseError("INVALID_DATE_RANGE", `${field} end must be after its start.`);
  }
}

export function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new DatabaseError("INVALID_QUANTITY", "Quantity must be a positive safe integer.", {
      quantity,
    });
  }
}

export function sumMinorUnits(...values: readonly bigint[]): bigint {
  let total = 0n;
  for (const [index, value] of values.entries()) {
    assertMinorUnits(value, `value[${index}]`);
    total += value;
    assertMinorUnits(total, "total");
  }
  assertMinorUnits(total, "total");
  return total;
}

export function toMinorUnitString(value: bigint): string {
  assertMinorUnits(value);
  return value.toString();
}
