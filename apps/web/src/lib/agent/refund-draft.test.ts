import { describe, expect, it } from "vitest";
import {
  consumeRefundDraft,
  readRefundDraft,
  REFUND_DRAFT_LIFETIME_MS,
  saveRefundDraft,
} from "./refund-draft";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

const draft = {
  paymentId: "payment_1",
  amountMinor: 2000,
  reason: "Damaged item",
  reviewUrl: "/orders/payment_1",
};

describe("refund review draft", () => {
  it("carries exact partial refund details once without storing review URLs or tokens", () => {
    const session = storage();
    saveRefundDraft(draft, session, 1000);
    expect([...session.values.values()][0]).not.toContain("reviewUrl");
    expect(consumeRefundDraft("payment_2", session, 1001)).toBeNull();
    expect(consumeRefundDraft("payment_1", session, 1001)).toEqual(draft);
    expect(consumeRefundDraft("payment_1", session, 1002)).toBeNull();
  });

  it("preserves the full remaining refund choice", () => {
    const session = storage();
    saveRefundDraft({ ...draft, amountMinor: null }, session, 1000);
    expect(consumeRefundDraft("payment_1", session, 1001)?.amountMinor).toBeNull();
  });

  it("discards expired drafts at the exact deadline", () => {
    const session = storage();
    saveRefundDraft(draft, session, 1000);
    expect(consumeRefundDraft("payment_1", session, 1000 + REFUND_DRAFT_LIFETIME_MS)).toBeNull();
    expect(session.values.size).toBe(0);
  });

  it.each([0, -1, 1.5, "2000", undefined, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid partial amount %s",
    (amountMinor) => {
      expect(() => readRefundDraft({ ...draft, amountMinor })).toThrow("refund draft");
    },
  );

  it.each([
    "https://attacker.test/orders/payment_1",
    "//attacker.test",
    "/orders/payment_2",
    "/orders/payment_1?token=secret",
  ])("rejects arbitrary review destination %s", (reviewUrl) => {
    expect(() => readRefundDraft({ ...draft, reviewUrl })).toThrow("destination");
  });

  it.each(["../payment_1", "payment_1/../../settings", "", "payment?token=secret"])(
    "rejects unsafe payment identity %s",
    (paymentId) => {
      expect(() => readRefundDraft({ ...draft, paymentId })).toThrow("refund draft");
    },
  );

  it.each(["", "   ", "a".repeat(501)])("rejects invalid reason", (reason) => {
    expect(() => readRefundDraft({ ...draft, reason })).toThrow("refund draft");
  });

  it.each([
    "invalid json",
    "null",
    JSON.stringify({ ...draft, expiresAt: 1000 + REFUND_DRAFT_LIFETIME_MS + 1 }),
    JSON.stringify({ ...draft, paymentId: "payment_2", expiresAt: 2000 }),
  ])("consumes and discards corrupt or mismatched entries", (serialized) => {
    const session = storage();
    session.setItem("mandatepay:refund-review:payment_1", serialized);
    expect(consumeRefundDraft("payment_1", session, 1000)).toBeNull();
    expect(session.values.size).toBe(0);
  });

  it("leaves manual review available when browser storage is unavailable", () => {
    const session = {
      ...storage(),
      getItem: () => {
        throw new Error("Storage denied");
      },
    };
    expect(consumeRefundDraft("payment_1", session)).toBeNull();
  });
});
