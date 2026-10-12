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

describe("admin security headers", () => {
  it("restricts production scripts, framing, plugins and form targets", () => {
    const policy = directives("production");
    expect(policy["default-src"]).toEqual(["'self'"]);
    expect(policy["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy["connect-src"]).toEqual(["'self'"]);
    expect(policy["frame-ancestors"]).toEqual(["'none'"]);
    expect(policy["object-src"]).toEqual(["'none'"]);
    expect(policy["form-action"]).toEqual(["'self'"]);
    expect(directives("development")["script-src"]).toContain("'unsafe-eval'");
  });

  it("keeps no-store caching and sends HSTS only from production builds", () => {
    const production = Object.fromEntries(
      securityHeaders("production").map(({ key, value }) => [key, value]),
    );
    expect(production).toMatchObject({
      "Cache-Control": "private, no-store",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Frame-Options": "DENY",
    });
    expect(securityHeaders("test").map(({ key }) => key)).not.toContain(
      "Strict-Transport-Security",
    );
  });
});
