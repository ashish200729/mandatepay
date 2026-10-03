import { describe, expect, it } from "vitest";
import { env, environmentSchema } from "./env.js";

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
});
