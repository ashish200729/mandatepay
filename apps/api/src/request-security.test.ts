import { describe, expect, it } from "vitest";
import {
  deriveProductContextSecret,
  internalProxySecretMatches,
  normalizeClientIp,
  resolveClientIp,
  trustProxyHops,
} from "./request-security.js";

const secret = "fixture-internal-proxy-secret-0123456789";

describe("request security helpers", () => {
  it("matches the internal proxy secret exactly and fails closed without configuration", () => {
    expect(internalProxySecretMatches(secret, secret)).toBe(true);
    expect(internalProxySecretMatches(`${secret}x`, secret)).toBe(false);
    expect(internalProxySecretMatches(secret.slice(0, -1), secret)).toBe(false);
    expect(internalProxySecretMatches("", secret)).toBe(false);
    expect(internalProxySecretMatches([secret], secret)).toBe(false);
    expect(internalProxySecretMatches(secret, undefined)).toBe(false);
    expect(internalProxySecretMatches(undefined, undefined)).toBe(false);
  });

  it("accepts only literal IPv4 and IPv6 client addresses", () => {
    expect(normalizeClientIp(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(normalizeClientIp("2001:db8::1")).toBe("2001:db8::1");
    for (const value of ["203.0.113.9, 10.0.0.1", "example.com", "", undefined, ["1.1.1.1"]]) {
      expect(normalizeClientIp(value)).toBeNull();
    }
  });

  it("resolves the forwarded client address only with a matching secret", () => {
    const headers = {
      "x-mandatepay-client-ip": "203.0.113.9",
      "x-mandatepay-proxy-secret": secret,
    };
    expect(resolveClientIp(headers, "10.0.0.5", secret)).toBe("203.0.113.9");
    expect(resolveClientIp(headers, "10.0.0.5", undefined)).toBe("10.0.0.5");
    expect(
      resolveClientIp({ ...headers, "x-mandatepay-proxy-secret": "guess" }, "10.0.0.5", secret),
    ).toBe("10.0.0.5");
    expect(resolveClientIp({ "x-mandatepay-proxy-secret": secret }, "10.0.0.5", secret)).toBe(
      "10.0.0.5",
    );
  });

  it("expresses TRUST_PROXY as a bounded hop function", () => {
    expect(trustProxyHops(undefined)).toBe(false);
    expect(trustProxyHops(0)).toBe(false);
    const trust = trustProxyHops(2);
    expect(trust).not.toBe(false);
    if (trust === false) return;
    expect([0, 1, 2].map((hop) => trust("10.0.0.1", hop))).toEqual([true, true, false]);
  });

  it("derives a stable product-context key that differs from the auth secret", () => {
    const authSecret = "fixture-auth-secret-with-at-least-32-chars";
    const derived = deriveProductContextSecret(authSecret);
    expect(derived).toMatch(/^[0-9a-f]{64}$/u);
    expect(derived).toBe(deriveProductContextSecret(authSecret));
    expect(derived).not.toContain(authSecret);
    expect(deriveProductContextSecret(`${authSecret}!`)).not.toBe(derived);
  });
});
