import { describe, expect, it } from "vitest";
import { createMutationRateLimiter, isFinancialMutation, safeRequestPath } from "./rate-limits.js";

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
