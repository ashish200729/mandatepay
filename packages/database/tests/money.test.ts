import { describe, expect, it } from "vitest";
import {
  assertCurrency,
  assertMinorUnits,
  assertPositiveMinorUnits,
  assertQuantity,
  proposalFingerprint,
  SUPPORTED_CURRENCY,
} from "../src/index.js";
import { DatabaseError } from "../src/errors.js";

describe("database money boundaries", () => {
  it("accepts USD non-negative minor units and rejects unsafe inputs", () => {
    expect(() => assertCurrency(SUPPORTED_CURRENCY)).not.toThrow();
    expect(() => assertMinorUnits(0n)).not.toThrow();
    expect(() => assertMinorUnits(-1n)).toThrowError(DatabaseError);
    expect(() => assertMinorUnits(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrowError(
      DatabaseError,
    );
    expect(() => assertPositiveMinorUnits(0n)).toThrowError(DatabaseError);
    expect(() => assertPositiveMinorUnits(1n)).not.toThrow();
    expect(() => assertCurrency("EUR")).toThrowError(DatabaseError);
  });

  it("requires a positive safe quantity", () => {
    expect(() => assertQuantity(1)).not.toThrow();
    expect(() => assertQuantity(0)).toThrowError(DatabaseError);
    expect(() => assertQuantity(1.5)).toThrowError(DatabaseError);
  });

  it("creates a stable fingerprint without floating point money", () => {
    const input = {
      userId: "user",
      mandateId: "mandate",
      mandateVersionId: "version",
      productSnapshotId: "product",
      quantity: 1,
      subtotal: 16_900n,
      shipping: 0n,
      tax: 0n,
      total: 16_900n,
      currency: "USD",
    } as const;
    expect(proposalFingerprint(input)).toBe(proposalFingerprint({ ...input }));
    expect(proposalFingerprint({ ...input, total: 16_901n })).not.toBe(proposalFingerprint(input));
  });
});
