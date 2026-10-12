import { describe, expect, it } from "vitest";
import { env, environmentSchema } from "./env.js";

// Shape-only fixture: env validation never imports the key.
const fixtureSigningKey = JSON.stringify({ kty: "EC", crv: "P-256", x: "fx", y: "fy", d: "fd" });

describe("foundation environment", () => {
  it("provides validated runtime configuration", () => {
    expect(env.HOST).toBe(process.env.HOST ?? "127.0.0.1");
    expect(env.PORT).toBe(Number(process.env.PORT ?? 4000));
    expect(env.WEB_ORIGIN).toBe(process.env.WEB_ORIGIN ?? "http://localhost:3000");
    expect(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).toContain(env.LOG_LEVEL);
  });

  it("keeps local verification optional and requires production email configuration", () => {
    expect(environmentSchema.parse({}).AUTH_REQUIRE_EMAIL_VERIFICATION).toBeUndefined();
    const production = {
      NODE_ENV: "production",
      APP_URL: "https://example.com",
      AUTH_SECRET: "test-secret-with-at-least-32-characters",
      DATABASE_URL: "postgresql://unused",
    };
    expect(environmentSchema.safeParse(production).success).toBe(false);
    const configured = {
      ...production,
      RESEND_API_KEY: "fake-test-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      INTERNAL_PROXY_SECRET: "fixture-internal-proxy-secret-0123456789",
      MANDATE_SIGNING_KEY: fixtureSigningKey,
    };
    expect(environmentSchema.safeParse(configured).success).toBe(true);
    expect(
      environmentSchema.safeParse({ ...configured, AUTH_REQUIRE_EMAIL_VERIFICATION: "false" })
        .success,
    ).toBe(false);
    expect(environmentSchema.safeParse({ AUTH_REQUIRE_EMAIL_VERIFICATION: "1" }).success).toBe(
      false,
    );
  });

  it("requires a strong internal proxy secret in production and keeps it optional locally", () => {
    const local = environmentSchema.parse({ INTERNAL_PROXY_SECRET: "", TRUST_PROXY: "" });
    expect(local.INTERNAL_PROXY_SECRET).toBeUndefined();
    expect(local.TRUST_PROXY).toBeUndefined();
    expect(environmentSchema.safeParse({ INTERNAL_PROXY_SECRET: "too-short" }).success).toBe(false);
    const production = {
      NODE_ENV: "production",
      APP_URL: "https://example.com",
      AUTH_SECRET: "test-secret-with-at-least-32-characters",
      DATABASE_URL: "postgresql://unused",
      RESEND_API_KEY: "fake-test-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      MANDATE_SIGNING_KEY: fixtureSigningKey,
    };
    const missing = environmentSchema.safeParse(production);
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((issue) => issue.path.join("."))).toContain(
      "INTERNAL_PROXY_SECRET",
    );
    expect(
      environmentSchema.safeParse({
        ...production,
        INTERNAL_PROXY_SECRET: "fixture-internal-proxy-secret-0123456789",
      }).success,
    ).toBe(true);
  });

  it("accepts a bounded TRUST_PROXY hop count", () => {
    expect(environmentSchema.parse({ TRUST_PROXY: "1" }).TRUST_PROXY).toBe(1);
    for (const TRUST_PROXY of ["-1", "11", "1.5", "true"]) {
      expect(environmentSchema.safeParse({ TRUST_PROXY }).success).toBe(false);
    }
  });

  it("defaults PAYPAL_ENV to sandbox and accepts live only as an explicit value", () => {
    expect(environmentSchema.parse({}).PAYPAL_ENV).toBe("sandbox");
    expect(environmentSchema.parse({ PAYPAL_ENV: "live" }).PAYPAL_ENV).toBe("live");
    for (const PAYPAL_ENV of ["production", "LIVE", "https://api-m.paypal.com"]) {
      expect(environmentSchema.safeParse({ PAYPAL_ENV }).success).toBe(false);
    }
  });

  it("requires a mandate signing key in production and validates JWK shapes", () => {
    expect(
      environmentSchema.parse({ MANDATE_SIGNING_KEY: "" }).MANDATE_SIGNING_KEY,
    ).toBeUndefined();
    const production = {
      NODE_ENV: "production",
      APP_URL: "https://example.com",
      AUTH_SECRET: "test-secret-with-at-least-32-characters",
      DATABASE_URL: "postgresql://unused",
      RESEND_API_KEY: "fake-test-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      INTERNAL_PROXY_SECRET: "fixture-internal-proxy-secret-0123456789",
    };
    const missing = environmentSchema.safeParse(production);
    expect(missing.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "MANDATE_SIGNING_KEY",
    ]);
    expect(
      environmentSchema.safeParse({ ...production, MANDATE_SIGNING_KEY: fixtureSigningKey })
        .success,
    ).toBe(true);
    const publicOnly = JSON.stringify({ kty: "EC", crv: "P-256", x: "fx", y: "fy" });
    for (const MANDATE_SIGNING_KEY of [
      "not-json",
      publicOnly,
      JSON.stringify({ kty: "RSA", n: "n", e: "AQAB", d: "d" }),
      JSON.stringify({ kty: "EC", crv: "P-384", x: "fx", y: "fy", d: "fd" }),
    ]) {
      expect(environmentSchema.safeParse({ MANDATE_SIGNING_KEY }).success).toBe(false);
    }
    expect(
      environmentSchema.safeParse({ MANDATE_SIGNING_PREVIOUS_JWKS: `{"keys":[${publicOnly}]}` })
        .success,
    ).toBe(true);
    expect(
      environmentSchema.safeParse({ MANDATE_SIGNING_PREVIOUS_JWKS: `[${publicOnly}]` }).success,
    ).toBe(true);
    // A private key never belongs in the published verification set.
    expect(
      environmentSchema.safeParse({ MANDATE_SIGNING_PREVIOUS_JWKS: `[${fixtureSigningKey}]` })
        .success,
    ).toBe(false);
  });
});
