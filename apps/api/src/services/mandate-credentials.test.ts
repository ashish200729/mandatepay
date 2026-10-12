import { SignJWT, calculateJwkThumbprint, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { CanonicalMandateSchema } from "@mandatepay/shared";
import {
  CREDENTIAL_VCT,
  MANDATE_CREDENTIAL_TYP,
  MandateSigningConfigurationError,
  canonicalJson,
  checkoutFacts,
  closedMandateClaims,
  computeCheckoutHash,
  createMandateKeyring,
  credentialSubject,
  generateMandateSigningJwk,
  openCheckoutConstraints,
  openMandateClaims,
  openPaymentConstraints,
  parsePreviousJwks,
  publicJwks,
  signMandateCredential,
  verifyMandateCredential,
  type CheckoutProposalRecord,
  type OpenMandateFacts,
} from "./mandate-credentials.js";

const issuer = "https://api.mandatepay.test";
const startsAt = new Date("2026-10-01T00:00:00.000Z");
const expiresAt = new Date("2026-12-31T00:00:00.000Z");

const rules = CanonicalMandateSchema.parse({
  title: "Office headphones",
  productIntent: "Noise-cancelling headphones for calls",
  currency: "USD",
  timezone: "UTC",
  allowedBrands: ["Sony", "Bose"],
  blockedBrands: ["Acme"],
  allowedCategories: ["Headphones"],
  blockedCategories: ["Gift cards"],
  allowedConditions: ["NEW", "REFURBISHED"],
  autoSpendLimit: 15_000,
  transactionLimit: 30_000,
  dailyLimit: 40_000,
  weeklyLimit: 60_000,
  monthlyLimit: 90_000,
  quantityLimit: 2,
  allowedMerchants: ["Demo Audio"],
  blockedMerchants: ["Shady Shop"],
  newMerchantRequiresApproval: true,
});

const openFacts: OpenMandateFacts = {
  userId: "user-1",
  mandateId: "mandate-1",
  mandateVersionId: "version-1",
  version: 3,
  rules,
  startsAt,
  expiresAt,
};

const proposal: CheckoutProposalRecord = {
  id: "proposal-1",
  mandateVersionId: "version-1",
  quantity: 2,
  shipping: 500n,
  tax: 1_200n,
  total: 21_700n,
  currency: "USD",
  productSnapshot: {
    externalId: "demo-sony-wh",
    source: "demo",
    merchant: "Demo Audio",
    title: "Sony WH-1000XM5",
    condition: "NEW",
    price: 10_000n,
  },
};

function closedFacts(record = proposal) {
  return {
    userId: "user-1",
    mandateId: "mandate-1",
    version: 3,
    checkout: checkoutFacts(record),
    expiresAt,
  };
}

async function keyring(previousJwks?: string) {
  return createMandateKeyring({ issuer, nodeEnv: "test", previousJwks });
}

function tamperPayload(jwt: string, change: (payload: Record<string, unknown>) => void) {
  const [header, payload, signature] = jwt.split(".");
  const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  change(decoded);
  return `${header}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;
}

describe("AP2-shaped open mandate claims", () => {
  it("maps every payment rule to an AP2 v0.2 or documented MandatePay constraint", () => {
    expect(openPaymentConstraints(openFacts)).toEqual([
      { type: "payment.amount_range", currency: "USD", min: 0, max: 30_000 },
      {
        type: "payment.execution_date",
        not_before: "2026-10-01T00:00:00.000Z",
        not_after: "2026-12-31T00:00:00.000Z",
      },
      { type: "payment.allowed_payees", allowed: [{ id: "demo audio", name: "Demo Audio" }] },
      { type: "mandatepay.blocked_payees", blocked: [{ id: "shady shop", name: "Shady Shop" }] },
      {
        type: "mandatepay.window_budget",
        window: "DAILY",
        timezone: "UTC",
        currency: "USD",
        max: 40_000,
      },
      {
        type: "mandatepay.window_budget",
        window: "WEEKLY",
        timezone: "UTC",
        currency: "USD",
        max: 60_000,
      },
      {
        type: "mandatepay.window_budget",
        window: "MONTHLY",
        timezone: "UTC",
        currency: "USD",
        max: 90_000,
      },
      { type: "mandatepay.approval_threshold", currency: "USD", max_autonomous: 15_000 },
      { type: "mandatepay.new_merchant_requires_approval", required: true },
    ]);
  });

  it("maps every product rule to an AP2 v0.2 or documented MandatePay constraint", () => {
    expect(openCheckoutConstraints(openFacts)).toEqual([
      { type: "checkout.allowed_merchants", allowed: [{ id: "demo audio", name: "Demo Audio" }] },
      { type: "mandatepay.blocked_merchants", blocked: [{ id: "shady shop", name: "Shady Shop" }] },
      { type: "mandatepay.product_intent", description: "Noise-cancelling headphones for calls" },
      { type: "mandatepay.max_quantity", max: 2 },
      { type: "mandatepay.category_allowlist", allowed: ["Headphones"] },
      { type: "mandatepay.category_blocklist", blocked: ["Gift cards"] },
      { type: "mandatepay.brand_allowlist", allowed: ["Sony", "Bose"] },
      { type: "mandatepay.brand_blocklist", blocked: ["Acme"] },
      { type: "mandatepay.condition_allowlist", allowed: ["NEW", "REFURBISHED"] },
    ]);
  });

  it("omits empty allowlists and optional windows instead of signing 'nothing allowed'", () => {
    const minimal = {
      ...openFacts,
      rules: CanonicalMandateSchema.parse({
        ...rules,
        allowedBrands: [],
        blockedBrands: [],
        allowedCategories: [],
        blockedCategories: [],
        allowedMerchants: [],
        blockedMerchants: [],
        dailyLimit: undefined,
        weeklyLimit: undefined,
        monthlyLimit: undefined,
        newMerchantRequiresApproval: false,
      }),
    };
    expect(openPaymentConstraints(minimal).map((item) => item.type)).toEqual([
      "payment.amount_range",
      "payment.execution_date",
      "mandatepay.approval_threshold",
      "mandatepay.new_merchant_requires_approval",
    ]);
    expect(openCheckoutConstraints(minimal).map((item) => item.type)).toEqual([
      "mandatepay.product_intent",
      "mandatepay.max_quantity",
      "mandatepay.condition_allowlist",
    ]);
  });

  it("uses AP2 vct values, the mandate window and an opaque subject", () => {
    const claims = openMandateClaims("OPEN_PAYMENT", openFacts);
    expect(claims.vct).toBe("mandate.payment.open.1");
    expect(openMandateClaims("OPEN_CHECKOUT", openFacts).vct).toBe("mandate.checkout.open.1");
    expect(claims.nbf).toBe(startsAt.getTime() / 1000);
    expect(claims.exp).toBe(expiresAt.getTime() / 1000);
    expect(claims.sub).toBe(credentialSubject("user-1"));
    expect(claims.sub).not.toContain("user-1");
    expect(claims).not.toHaveProperty("cnf");
    expect(claims.mandatepay).toMatchObject({
      mandate_id: "mandate-1",
      mandate_version_id: "version-1",
      mandate_version: 3,
    });
    // Deterministic for the same version.
    expect(openMandateClaims("OPEN_PAYMENT", openFacts)).toEqual(claims);
  });
});

describe("checkout hash", () => {
  it("is canonical JSON with sorted keys and integer minor units", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 0, y: "q" } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":"q","z":0}}',
    );
    expect(() => canonicalJson({ amount: Number.NaN })).toThrow();
    const facts = checkoutFacts(proposal);
    expect(facts).toEqual({
      proposal_id: "proposal-1",
      mandate_version_id: "version-1",
      product_external_id: "demo-sony-wh",
      source: "demo",
      merchant: "Demo Audio",
      title: "Sony WH-1000XM5",
      condition: "NEW",
      quantity: 2,
      unit_price: 10_000,
      shipping: 500,
      tax: 1_200,
      total: 21_700,
      currency: "USD",
    });
  });

  it("is deterministic and changes when any bound cart fact changes", () => {
    const hash = computeCheckoutHash(checkoutFacts(proposal));
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(computeCheckoutHash(checkoutFacts({ ...proposal }))).toBe(hash);
    const variants: CheckoutProposalRecord[] = [
      { ...proposal, id: "proposal-2" },
      { ...proposal, mandateVersionId: "version-2" },
      { ...proposal, quantity: 3 },
      { ...proposal, shipping: 501n },
      { ...proposal, tax: 1_201n },
      { ...proposal, total: 21_701n },
      { ...proposal, productSnapshot: { ...proposal.productSnapshot, price: 9_999n } },
      { ...proposal, productSnapshot: { ...proposal.productSnapshot, merchant: "Other" } },
      { ...proposal, productSnapshot: { ...proposal.productSnapshot, title: "Sony + extra item" } },
      { ...proposal, productSnapshot: { ...proposal.productSnapshot, externalId: "demo-other" } },
      { ...proposal, productSnapshot: { ...proposal.productSnapshot, condition: "USED" } },
      { ...proposal, productSnapshot: { ...proposal.productSnapshot, source: "channel3" } },
    ];
    for (const variant of variants) {
      expect(computeCheckoutHash(checkoutFacts(variant))).not.toBe(hash);
    }
  });

  it("refuses unsafe money values", () => {
    expect(() => checkoutFacts({ ...proposal, total: 2n ** 60n })).toThrow();
    expect(() => checkoutFacts({ ...proposal, tax: -1n })).toThrow();
  });

  it("binds closed payment mandates to the checkout hash, payee and amount", () => {
    const hash = computeCheckoutHash(checkoutFacts(proposal));
    const checkout = closedMandateClaims("CLOSED_CHECKOUT", closedFacts());
    expect(checkout).toMatchObject({ vct: "mandate.checkout.1", checkout_hash: hash });
    const payment = closedMandateClaims("CLOSED_PAYMENT", closedFacts());
    expect(payment).toMatchObject({
      vct: "mandate.payment.1",
      transaction_id: hash,
      payee: { id: "demo audio", name: "Demo Audio" },
      payment_amount: { amount: 21_700, currency: "USD" },
      payment_instrument: { type: "paypal" },
    });
  });
});

describe("signing and verification", () => {
  it("round-trips an ES256 JWS with the MandatePay typ and an RFC 7638 kid", async () => {
    const keys = await keyring();
    const jwt = await signMandateCredential(keys, openMandateClaims("OPEN_PAYMENT", openFacts));
    const [header] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString("utf8"))).toEqual({
      alg: "ES256",
      typ: MANDATE_CREDENTIAL_TYP,
      kid: keys.current.kid,
    });
    const { kid, ...thumbprintInput } = keys.current.publicJwk;
    expect(
      await calculateJwkThumbprint(
        {
          kty: thumbprintInput.kty,
          crv: thumbprintInput.crv,
          x: thumbprintInput.x,
          y: thumbprintInput.y,
        },
        "sha256",
      ),
    ).toBe(kid);
    const result = await verifyMandateCredential(keys, jwt, {
      currentDate: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ valid: true, kind: "OPEN_PAYMENT", reason: null, kid });
    expect(result.claims?.constraints.map((item) => item.type)).toContain("payment.amount_range");
    expect(result.claims?.iss).toBe(issuer);
  });

  it("publishes only public keys in the JWKS", async () => {
    const keys = await keyring();
    const jwks = publicJwks(keys);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(jwks.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
  });

  it("rejects a tampered payload and a tampered checkout hash", async () => {
    const keys = await keyring();
    const now = new Date("2026-11-01T00:00:00.000Z");
    const jwt = await signMandateCredential(
      keys,
      closedMandateClaims("CLOSED_CHECKOUT", closedFacts()),
      now,
    );
    expect((await verifyMandateCredential(keys, jwt, { currentDate: now })).valid).toBe(true);
    const tampered = tamperPayload(jwt, (payload) => {
      (payload.mandatepay_checkout as Record<string, unknown>).total = 1;
    });
    expect(await verifyMandateCredential(keys, tampered, { currentDate: now })).toMatchObject({
      valid: false,
      reason: "SIGNATURE_INVALID",
    });
    // Even a validly signed credential is refused when its cart does not hash to checkout_hash.
    const inconsistent = await signMandateCredential(
      keys,
      {
        ...closedMandateClaims("CLOSED_CHECKOUT", closedFacts()),
        checkout_hash: computeCheckoutHash(checkoutFacts({ ...proposal, total: 1n })),
      },
      now,
    );
    expect(await verifyMandateCredential(keys, inconsistent, { currentDate: now })).toMatchObject({
      valid: false,
      reason: "CHECKOUT_HASH_MISMATCH",
      kind: "CLOSED_CHECKOUT",
    });
  });

  it("verifies credentials from a previous key only when its public key is configured", async () => {
    const oldKeys = await keyring();
    const jwt = await signMandateCredential(oldKeys, openMandateClaims("OPEN_CHECKOUT", openFacts));
    const at = { currentDate: new Date("2026-11-01T00:00:00.000Z") };
    const rotated = await keyring();
    expect(await verifyMandateCredential(rotated, jwt, at)).toMatchObject({
      valid: false,
      reason: "UNKNOWN_KEY",
    });
    const withPrevious = await keyring(JSON.stringify(publicJwks(oldKeys)));
    expect(withPrevious.verificationKeys.size).toBe(2);
    expect(await verifyMandateCredential(withPrevious, jwt, at)).toMatchObject({
      valid: true,
      kind: "OPEN_CHECKOUT",
      kid: oldKeys.current.kid,
    });
    // Previous keys verify only: new credentials are signed with the current key.
    const fresh = await signMandateCredential(
      withPrevious,
      openMandateClaims("OPEN_CHECKOUT", openFacts),
    );
    expect((await verifyMandateCredential(withPrevious, fresh, at)).kid).toBe(
      withPrevious.current.kid,
    );
  });

  it("rejects the wrong typ, a non-ES256 algorithm, issuer, expiry and unknown types", async () => {
    const keys = await keyring();
    const at = new Date("2026-11-01T00:00:00.000Z");
    const claims = { ...openMandateClaims("OPEN_PAYMENT", openFacts), iss: issuer };
    const wrongTyp = await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: keys.current.kid })
      .sign(keys.current.privateKey);
    expect((await verifyMandateCredential(keys, wrongTyp, { currentDate: at })).reason).toBe(
      "WRONG_TYPE",
    );
    const hmac = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: MANDATE_CREDENTIAL_TYP, kid: keys.current.kid })
      .sign(new TextEncoder().encode("a-shared-secret-that-must-never-verify-32"));
    expect((await verifyMandateCredential(keys, hmac, { currentDate: at })).reason).toBe(
      "UNSUPPORTED_ALGORITHM",
    );
    const es384 = await generateKeyPair("ES384");
    const otherCurve = await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES384", typ: MANDATE_CREDENTIAL_TYP, kid: keys.current.kid })
      .sign(es384.privateKey);
    expect((await verifyMandateCredential(keys, otherCurve, { currentDate: at })).reason).toBe(
      "UNSUPPORTED_ALGORITHM",
    );
    const otherIssuer = await signMandateCredential(
      { ...keys, issuer: "https://evil.test" },
      openMandateClaims("OPEN_PAYMENT", openFacts),
      at,
    );
    expect((await verifyMandateCredential(keys, otherIssuer, { currentDate: at })).reason).toBe(
      "WRONG_ISSUER",
    );
    const valid = await signMandateCredential(keys, openMandateClaims("OPEN_PAYMENT", openFacts));
    expect(
      (
        await verifyMandateCredential(keys, valid, {
          currentDate: new Date("2027-01-02T00:00:00Z"),
        })
      ).reason,
    ).toBe("EXPIRED");
    const unknown = await signMandateCredential(keys, { vct: "mandate.other.1" });
    expect((await verifyMandateCredential(keys, unknown)).reason).toBe("UNKNOWN_MANDATE_TYPE");
    for (const malformed of ["", "a.b", "not a jwt", "x".repeat(20_000)]) {
      expect((await verifyMandateCredential(keys, malformed)).reason).toBe("MALFORMED");
    }
  });

  it("covers all four AP2 vct values", () => {
    expect(Object.values(CREDENTIAL_VCT)).toEqual([
      "mandate.payment.open.1",
      "mandate.checkout.open.1",
      "mandate.checkout.1",
      "mandate.payment.1",
    ]);
  });
});

describe("key configuration", () => {
  it("requires a configured key in production and accepts a valid private JWK", async () => {
    await expect(createMandateKeyring({ issuer, nodeEnv: "production" })).rejects.toBeInstanceOf(
      MandateSigningConfigurationError,
    );
    const jwk = await generateMandateSigningJwk();
    const configured = await createMandateKeyring({
      issuer,
      nodeEnv: "production",
      signingKey: JSON.stringify(jwk),
    });
    expect(configured.ephemeral).toBe(false);
    const again = await createMandateKeyring({
      issuer,
      nodeEnv: "production",
      signingKey: JSON.stringify(jwk),
    });
    expect(again.current.kid).toBe(configured.current.kid);
    expect((await keyring()).ephemeral).toBe(true);
  });

  it("rejects malformed keys and private keys in the previous JWKS", async () => {
    await expect(
      createMandateKeyring({ issuer, nodeEnv: "production", signingKey: "{}" }),
    ).rejects.toBeInstanceOf(MandateSigningConfigurationError);
    const jwk = await generateMandateSigningJwk();
    expect(() => parsePreviousJwks(JSON.stringify([jwk]))).toThrow(
      MandateSigningConfigurationError,
    );
    expect(() => parsePreviousJwks("not json")).toThrow(MandateSigningConfigurationError);
    expect(parsePreviousJwks(undefined)).toEqual([]);
  });
});
