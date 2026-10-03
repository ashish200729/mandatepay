import { describe, expect, it } from "vitest";
import {
  formatUsdLabel,
  formatUsdMinor,
  fromUtcIso,
  parseQuantity,
  parseUsdDecimal,
  toUtcIso,
} from "./money";

describe("mandate money and UTC helpers", () => {
  it("converts strict USD decimals to integer cents", () => {
    expect(parseUsdDecimal("150")).toBe(15_000);
    expect(parseUsdDecimal("150.5")).toBe(15_050);
    expect(parseUsdDecimal("0.09")).toBe(9);
    expect(formatUsdMinor(15_050)).toBe("150.50");
    expect(formatUsdLabel(15_050)).toBe("$150.50");
  });

  it("rejects float-like or unsafe money input", () => {
    for (const value of ["-1", "1.234", "1e2", "1.", "01.00"]) {
      expect(() => parseUsdDecimal(value)).toThrow();
    }
  });

  it("keeps datetime-local fields explicitly in UTC", () => {
    const iso = toUtcIso("2026-10-10T09:30");
    expect(iso).toBe("2026-10-10T09:30:00.000Z");
    expect(fromUtcIso(iso)).toBe("2026-10-10T09:30");
  });

  it("accepts only positive whole quantities", () => {
    expect(parseQuantity("2")).toBe(2);
    expect(() => parseQuantity("0")).toThrow();
    expect(() => parseQuantity("1.5")).toThrow();
  });
});
