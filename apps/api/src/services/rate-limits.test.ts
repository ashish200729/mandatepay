import { describe, expect, it } from "vitest";
import {
  createFixedWindowRateLimiter,
  createMutationRateLimiter,
  credentialAttemptEmail,
  isFinancialMutation,
  safeRequestPath,
} from "./rate-limits.js";

describe("authentication rate-limit keys", () => {
  it("normalizes credential emails for sign-in and sign-up only", () => {
    const body = { email: "  Judge@Example.TEST ", password: "x" };
    expect(credentialAttemptEmail("POST", "/api/auth/sign-in/email", body)).toBe(
      "judge@example.test",
    );
    expect(credentialAttemptEmail("POST", "/api/auth/sign-up/email?x=1", body)).toBe(
      "judge@example.test",
    );
    expect(credentialAttemptEmail("POST", "/api/auth/sign-in/email", JSON.stringify(body))).toBe(
      "judge@example.test",
    );
    expect(credentialAttemptEmail("GET", "/api/auth/sign-in/email", body)).toBeNull();
    expect(credentialAttemptEmail("POST", "/api/auth/request-password-reset", body)).toBeNull();
    expect(credentialAttemptEmail("POST", "/api/auth/sign-in/email", "{bad")).toBeNull();
    expect(credentialAttemptEmail("POST", "/api/auth/sign-in/email", { email: 1 })).toBeNull();
    expect(credentialAttemptEmail("POST", "/api/auth/sign-in/email", [body])).toBeNull();
    expect(credentialAttemptEmail("POST", "/api/auth/sign-in/email", { email: "   " })).toBeNull();
  });

  it("applies the generic fixed-window limiter to arbitrary keys", () => {
    const consume = createFixedWindowRateLimiter({ maximum: 1, windowMs: 1_000, capacity: 2 });
    expect(consume("email:a", 0).allowed).toBe(true);
    expect(consume("email:a", 1)).toEqual({ allowed: false, retryAfter: 1 });
    expect(consume("email:b", 1).allowed).toBe(true);
    expect(consume("email:c", 1)).toEqual({ allowed: false, retryAfter: 1 });
  });
});

describe("financial mutation rate limits", () => {
  it("omits verification queries and password-reset path tokens from log paths", () => {
    expect(safeRequestPath("/api/auth/verify-email?token=private-value")).toBe(
      "/api/auth/verify-email",
    );
    expect(safeRequestPath("/api/auth/reset-password/private-token?callbackURL=x")).toBe(
      "/api/auth/reset-password/[REDACTED]",
    );
  });
  it("isolates users, returns a retry delay and resets an expired window", () => {
    const consume = createMutationRateLimiter({ maximum: 2, windowMs: 60_000 });
    expect(consume("a", 0).allowed).toBe(true);
    expect(consume("a", 1).allowed).toBe(true);
    expect(consume("a", 2)).toEqual({ allowed: false, retryAfter: 60 });
    expect(consume("b", 2).allowed).toBe(true);
    expect(consume("a", 60_000).allowed).toBe(true);
  });
  it("bounds memory and cleans expired users before accepting new ones", () => {
    const consume = createMutationRateLimiter({ capacity: 1 });
    expect(consume("a", 0).allowed).toBe(true);
    expect(consume("b", 1).allowed).toBe(false);
    expect(consume("b", 60_000).allowed).toBe(true);
  });
  it("covers proposal, approval, order, capture and refund writes without throttling reads or webhooks", () => {
    for (const path of [
      "/api/proposals",
      "/api/proposals/a/approve",
      "/api/proposals/a/evaluate",
      "/api/paypal/orders",
      "/api/paypal/orders/a/capture",
      "/api/paypal/orders/a/reconcile",
      "/api/payments/a/refund",
      "/api/payments/a/refund-status",
    ]) {
      expect(isFinancialMutation("POST", path)).toBe(true);
      expect(isFinancialMutation("GET", path)).toBe(false);
    }
    expect(isFinancialMutation("POST", "/api/webhooks/paypal")).toBe(false);
  });
});
