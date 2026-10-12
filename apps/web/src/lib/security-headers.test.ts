import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "../../security-headers.mjs";

function directives(mode: string) {
  return Object.fromEntries(
    contentSecurityPolicy(mode)
      .split("; ")
      .map((directive) => {
        const [name = "", ...values] = directive.split(" ");
        return [name, values];
      }),
  );
}

describe("web security headers", () => {
  it("keeps production scripts free of eval while allowing App Router inline bootstrap", () => {
    const policy = directives("production");
    expect(policy["default-src"]).toEqual(["'self'"]);
    expect(policy["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy["connect-src"]).toEqual(["'self'"]);
    expect(policy["frame-ancestors"]).toEqual(["'none'"]);
    expect(policy["object-src"]).toEqual(["'none'"]);
    expect(policy["base-uri"]).toEqual(["'self'"]);
    expect(policy["font-src"]).toEqual(["'self'", "data:"]);
    expect(policy["img-src"]).toEqual(["'self'", "data:", "blob:", "https:"]);
    expect(policy["form-action"]).toEqual([
      "'self'",
      "https://www.paypal.com",
      "https://www.sandbox.paypal.com",
    ]);
  });

  it("allows eval and HMR websockets only for the development server", () => {
    expect(directives("development")["script-src"]).toContain("'unsafe-eval'");
    expect(directives("development")["connect-src"]).toEqual(["'self'", "ws:", "wss:"]);
    expect(directives("test")["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("sends HSTS only from production builds and keeps existing protections", () => {
    const production = Object.fromEntries(
      securityHeaders("production").map(({ key, value }) => [key, value]),
    );
    expect(production).toMatchObject({
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    expect(securityHeaders("development").map(({ key }) => key)).not.toContain(
      "Strict-Transport-Security",
    );
  });
});
