import { describe, expect, it } from "vitest";
import { activeShoppingMandates, selectShoppingMandate } from "./mandates";
import type { MandateDetail } from "../mandates/types";

const now = Date.parse("2026-10-03T12:00:00Z");
function mandate(overrides: Partial<MandateDetail> = {}): MandateDetail {
  return {
    id: "mandate_1",
    title: "Headphones",
    status: "ACTIVE",
    version: 1,
    originalPrompt: "Headphones",
    rules: {} as MandateDetail["rules"],
    startsAt: "2026-10-03T11:00:00Z",
    expiresAt: "2026-10-03T13:00:00Z",
    ...overrides,
  };
}

describe("chat mandate choice", () => {
  it("uses authoritative active status and start/expiry boundaries", () => {
    const valid = mandate({ startsAt: "2026-10-03T12:00:00Z" });
    const invalid = [
      mandate({ status: "PAUSED" }),
      mandate({ startsAt: "2026-10-03T12:00:01Z" }),
      mandate({ expiresAt: "2026-10-03T12:00:00Z" }),
      mandate({ startsAt: "invalid" }),
      mandate({ expiresAt: undefined }),
    ];
    expect(activeShoppingMandates([valid, ...invalid], now)).toEqual([valid]);
  });

  it("does not substitute rule JSON for trusted window fields", () => {
    expect(
      activeShoppingMandates(
        [
          mandate({
            startsAt: undefined,
            rules: { startsAt: "2026-10-03T11:00:00Z" } as MandateDetail["rules"],
          }),
        ],
        now,
      ),
    ).toEqual([]);
  });

  it("requires a deliberate choice among multiple mandates and preserves that choice", () => {
    const multiple = [mandate(), mandate({ id: "mandate_2" })];
    expect(selectShoppingMandate(multiple, "")).toBe("");
    expect(selectShoppingMandate(multiple, "mandate_2")).toBe("mandate_2");
    expect(selectShoppingMandate(multiple, "removed_mandate")).toBe("");
    expect(selectShoppingMandate([mandate()], "")).toBe("mandate_1");
    expect(selectShoppingMandate([], "mandate_1")).toBe("");
  });
});
