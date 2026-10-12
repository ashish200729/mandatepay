import { describe, expect, it } from "vitest";
import {
  credentialFileName,
  describeConstraint,
  hashPrefix,
  parseCartMandate,
  parseMandateCredentialSet,
} from "./credentials";

const credential = {
  id: "0d8c1f2e-aaaa-bbbb-cccc-000000000000",
  kind: "OPEN_PAYMENT",
  vct: "mandate.payment.open.1",
  kid: "kid-1",
  jwt: "aaa.bbb.ccc",
  digest: "f".repeat(64),
  checkoutHash: null,
  issuedAt: "2026-10-12T00:00:00.000Z",
  notBefore: "2026-10-12T00:00:00.000Z",
  expiresAt: "2026-12-31T00:00:00.000Z",
  verified: true,
  verificationReason: null,
  constraints: [{ type: "payment.amount_range", currency: "USD", min: 0, max: 30_000 }, "bad"],
  paymentAmount: null,
};

describe("mandate credential helpers", () => {
  it("parses credential sets and drops malformed constraints", () => {
    const set = parseMandateCredentialSet({
      mandateId: "m-1",
      mandateStatus: "ACTIVE",
      version: 2,
      issuer: "https://api.example",
      credentials: [credential],
    });
    expect(set.version).toBe(2);
    expect(set.credentials[0]?.constraints).toEqual([
      { type: "payment.amount_range", currency: "USD", min: 0, max: 30_000 },
    ]);
    expect(() =>
      parseMandateCredentialSet({ credentials: [{ ...credential, kind: "OTHER" }] }),
    ).toThrow();
    expect(() =>
      parseMandateCredentialSet({ credentials: [{ ...credential, verified: "yes" }] }),
    ).toThrow();
  });

  it("treats only an explicit true hashVerified as verified", () => {
    expect(parseCartMandate({ hashVerified: "true", credentials: [] }).hashVerified).toBe(false);
    expect(
      parseCartMandate({ hashVerified: true, checkoutHash: "abc", credentials: [] }).hashVerified,
    ).toBe(true);
  });

  it("describes AP2 and MandatePay constraints in plain language", () => {
    expect(
      describeConstraint({ type: "payment.amount_range", currency: "USD", min: 0, max: 30_000 }),
    ).toMatchObject({
      rule: "Per-purchase amount",
      value: "$0.00 – $300.00",
      standard: "AP2 v0.2",
    });
    expect(
      describeConstraint({
        type: "payment.allowed_payees",
        allowed: [{ id: "demo", name: "Demo Audio" }],
      }).value,
    ).toBe("Demo Audio");
    expect(
      describeConstraint({ type: "mandatepay.window_budget", window: "DAILY", max: 5_000 }),
    ).toMatchObject({
      rule: "Daily budget",
      value: "$50.00 per day (UTC)",
      standard: "MandatePay extension",
    });
    expect(
      describeConstraint({ type: "mandatepay.approval_threshold", max_autonomous: 15_000 }).value,
    ).toBe("$150.00; above needs your approval");
    expect(
      describeConstraint({ type: "mandatepay.condition_allowlist", allowed: ["NEW", "USED"] })
        .value,
    ).toBe("NEW, USED");
    expect(
      describeConstraint({ type: "mandatepay.new_merchant_requires_approval", required: true })
        .value,
    ).toBe("Needs your approval");
    expect(describeConstraint({ type: "payment.agent_recurrence" }).value).toBe(
      "Recorded in the credential",
    );
  });

  it("names downloads and shortens hashes", () => {
    expect(credentialFileName({ kind: "CLOSED_CHECKOUT", id: "12345678-abcd" })).toBe(
      "mandatepay-closed-checkout-12345678.jwt",
    );
    expect(hashPrefix("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijkl");
    expect(hashPrefix(null)).toBe("—");
  });
});
