import { describe, expect, it } from "vitest";
import {
  DomainError,
  addMinorUnits,
  calculatePurchaseTotal,
  formatMinorUnits,
  minorUnitsSchema,
  multiplyMinorUnits,
  parseDecimalToMinorUnits,
  toMinorUnits,
  type MinorUnits,
} from "../src/index.js";

describe("money contracts", () => {
  it("parses and formats USD decimal strings without floating-point arithmetic", () => {
    const value = parseDecimalToMinorUnits("12.34");

    expect(value).toBe(1234);
    expect(formatMinorUnits(value)).toBe("12.34");
    expect(formatMinorUnits(parseDecimalToMinorUnits("0"))).toBe("0.00");
  });

  it.each(["", " 1.00", "1.000", "01.00", ".50", "1.", "-1.00", "+1.00", "1e2"])(
    "rejects malformed decimal input %s",
    (value) => {
      expect(() => parseDecimalToMinorUnits(value)).toThrowError(
        expect.objectContaining({ code: "INVALID_MONEY" }),
      );
    },
  );

  it("rejects numeric input even when it looks like a valid amount", () => {
    expect(() => parseDecimalToMinorUnits(12.34 as unknown as string)).toThrowError(
      expect.objectContaining({ code: "INVALID_MONEY" }),
    );
    expect(() => formatMinorUnits(12.34 as unknown as MinorUnits)).toThrowError(
      expect.objectContaining({ code: "INVALID_MONEY" }),
    );
  });

  it("rejects unsafe, fractional, negative, and string minor-unit values", () => {
    expect(minorUnitsSchema.safeParse(1.5).success).toBe(false);
    expect(minorUnitsSchema.safeParse(-1).success).toBe(false);
    expect(minorUnitsSchema.safeParse("100").success).toBe(false);
    expect(minorUnitsSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(minorUnitsSchema.safeParse(Number.NaN).success).toBe(false);
  });

  it("checks integer addition, multiplication, and totals for overflow", () => {
    expect(addMinorUnits(toMinorUnits(100), toMinorUnits(25))).toBe(125);
    expect(multiplyMinorUnits(toMinorUnits(125), 2)).toBe(250);
    expect(
      calculatePurchaseTotal({
        subtotal: toMinorUnits(1000),
        shipping: toMinorUnits(200),
        tax: toMinorUnits(80),
      }),
    ).toBe(1280);

    expect(() => multiplyMinorUnits(toMinorUnits(2), 0)).toThrowError(
      expect.objectContaining({ code: "INVALID_DOMAIN_INPUT" }),
    );
    expect(() =>
      addMinorUnits(toMinorUnits(Number.MAX_SAFE_INTEGER), toMinorUnits(1)),
    ).toThrowError(expect.objectContaining({ code: "MONEY_OUT_OF_RANGE" }));
    expect(() =>
      calculatePurchaseTotal({
        subtotal: toMinorUnits(Number.MAX_SAFE_INTEGER),
        shipping: toMinorUnits(1),
        tax: toMinorUnits(0),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TOTAL" }));
  });

  it("keeps domain errors typed", () => {
    try {
      parseDecimalToMinorUnits("999999999999999999999999.99");
      throw new Error("expected parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("MONEY_OUT_OF_RANGE");
    }
  });
});
