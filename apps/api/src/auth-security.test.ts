import { describe, expect, it } from "vitest";
import { createAuthRuntime } from "./auth.js";
import { environmentSchema } from "./env.js";

describe("admin configuration safeguards", () => {
  it("rejects credential-bearing, path, query and non-HTTP admin origins", () => {
    for (const ADMIN_ORIGIN of [
      "https://user:password@admin.example",
      "https://admin.example/path",
      "https://admin.example?token=x",
      "https://admin.example#x",
      "ftp://admin.example",
    ]) {
      expect(environmentSchema.safeParse({ ADMIN_ORIGIN }).success).toBe(false);
    }
    expect(environmentSchema.parse({ ADMIN_ORIGIN: "http://localhost:3001" }).ADMIN_ORIGIN).toBe(
      "http://localhost:3001",
    );
  });
  it("requires HTTPS for a configured production admin", () => {
    const production = {
      NODE_ENV: "production",
      APP_URL: "https://web.example",
      DATABASE_URL: "postgresql://unused",
      AUTH_SECRET: "fixture-secret-at-least-32-characters",
      RESEND_API_KEY: "fixture-key",
      AUTH_EMAIL_FROM: "auth@example.test",
    };
    expect(
      environmentSchema.safeParse({ ...production, ADMIN_ORIGIN: "http://admin.example" }).success,
    ).toBe(false);
    expect(
      environmentSchema.safeParse({ ...production, ADMIN_ORIGIN: "https://admin.example" }).success,
    ).toBe(true);
  });
  it("cannot enable fixture auth limits in production or a non-test database", () => {
    const fixture = {
      databaseUrl: "postgresql://localhost/mandatepay_test",
      authSecret: "fixture-secret-at-least-32-characters",
      appUrl: "http://localhost:3000",
      nodeEnv: "test" as const,
      testRateLimitMaximum: 500,
    };
    expect(() => createAuthRuntime({ ...fixture, nodeEnv: "production" })).toThrow(
      "isolated test database",
    );
    expect(() =>
      createAuthRuntime({ ...fixture, databaseUrl: "postgresql://localhost/mandatepay" }),
    ).toThrow("isolated test database");
    expect(() => createAuthRuntime({ ...fixture, testRateLimitMaximum: 501 })).toThrow(
      "isolated test database",
    );
  });
});
