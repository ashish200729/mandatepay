import { describe, expect, it } from "vitest";
import { originsFor, trustedOrigin } from "./origins.js";
import { trustedOriginsFor } from "./auth.js";
import { environmentSchema } from "./env.js";
describe("admin trusted origins", () => {
  it("adds only exact origins and same-port loopback aliases outside production", () => {
    expect(trustedOriginsFor("http://localhost:3000", "test", "http://localhost:3001")).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
    ]);
    expect(originsFor("https://admin.example.com", "production")).toEqual([
      "https://admin.example.com",
    ]);
    for (const value of [
      undefined,
      "https://admin.example.com/path",
      "https://admin.example.com.evil.test",
      "null",
    ])
      expect(trustedOrigin(value, ["https://admin.example.com"])).toBe(false);
  });
  it("rejects credential-bearing/path origins and insecure production admin origins", () => {
    for (const value of [
      "http://user:pass@localhost:3001",
      "http://localhost:3001/path",
      "http://localhost:3001?key=x",
      "ftp://localhost:3001",
      "http://localhost:3001#x",
    ])
      expect(environmentSchema.safeParse({ ADMIN_ORIGIN: value }).success).toBe(false);
    const production = {
      NODE_ENV: "production",
      APP_URL: "https://app.example.com",
      DATABASE_URL: "postgresql://unused",
      AUTH_SECRET: "test-secret-with-at-least-32-characters",
      RESEND_API_KEY: "fixture",
      AUTH_EMAIL_FROM: "auth@example.com",
    };
    expect(
      environmentSchema.safeParse({ ...production, ADMIN_ORIGIN: "http://admin.example.com" })
        .success,
    ).toBe(false);
    expect(
      environmentSchema.safeParse({ ...production, ADMIN_ORIGIN: "https://admin.example.com" })
        .success,
    ).toBe(true);
  });
});
