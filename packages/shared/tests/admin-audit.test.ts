import { describe, expect, it } from "vitest";
import {
  buildAdminSummary,
  requireAdminReason,
  AdminAuditQuerySchema,
  parseAdminAuditEvent,
} from "../src/admin-audit.js";

describe("admin audit redaction and contract", () => {
  it("projects approved scalar facts and discards nested credentials and provider payloads", () => {
    expect(
      buildAdminSummary("USER", {
        emailVerified: true,
        autonomousPurchasingEnabled: false,
        password: "unsafe",
        accounts: [{ accessToken: "unsafe" }],
        email: "private@example.test",
        originalPrompt: "private",
      }),
    ).toEqual({ emailVerified: true, autonomousPurchasingEnabled: false });
    expect(
      buildAdminSummary("PAYMENT", {
        status: "CAPTURE_PENDING",
        amountMinor: 100,
        currency: "USD",
        providerResponse: { token: "unsafe" },
        paypalOrderId: "private",
      }),
    ).toEqual({ status: "CAPTURE_PENDING", amountMinor: 100, currency: "USD" });
    expect(
      buildAdminSummary("ADMIN_AUTH", { email: "private@example.test", cookie: "unsafe" }),
    ).toEqual({});
    expect(() => buildAdminSummary("PAYMENT", { status: "password=unsafe" })).toThrow();
    expect(() =>
      buildAdminSummary("PAYMENT", { amountMinor: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
  });
  it("requires a bounded human reason and rejects recognizable credential material", () => {
    expect(requireAdminReason("  Investigating ticket MP-104.  ")).toBe(
      "Investigating ticket MP-104.",
    );
    for (const value of [
      "",
      " ",
      "x".repeat(256),
      "password=fixture",
      "Bearer fixture-token",
      "secret: fixture",
      "cookie=fixture",
      "api_key=fixture",
      "https://example.test?token=fixture",
      "-----BEGIN PRIVATE KEY-----",
      "A".repeat(64),
      "line\nbreak",
    ])
      expect(() => requireAdminReason(value)).toThrow();
  });
  it("bounds enum/date/query filters, rejects unknown keys and validates target types", () => {
    expect(AdminAuditQuerySchema.parse({ limit: "2", action: "ADMIN_LOGIN_FAILED" }).limit).toBe(2);
    for (const value of [
      { token: "unsafe" },
      { action: "anything" },
      { limit: 101 },
      { limit: 0 },
      { from: "2026-10-05T00:00:00Z" },
      { from: "2026-10-05T00:00:00Z", to: "2026-10-05T00:00:00Z" },
      { from: "2025-01-01T00:00:00Z", to: "2026-10-05T00:00:00Z" },
      { targetId: "fixture" },
      { targetType: "USER", targetId: "platform.maintenanceMode" },
    ])
      expect(AdminAuditQuerySchema.safeParse(value).success).toBe(false);
  });
  it("drops unknown DTO fields and rejects unsafe summaries or free-form errors", () => {
    const event = {
      id: "11111111-1111-4111-8111-111111111111",
      actorAdminId: null,
      actorUserId: null,
      role: null,
      action: "ADMIN_LOGIN_FAILED",
      targetType: "ADMIN_AUTH",
      targetId: "main",
      reason: "Administrator credential sign-in rejected.",
      requestId: "11111111-1111-4111-8111-111111111111",
      correlationId: "11111111-1111-4111-8111-111111111111",
      actionId: null,
      beforeSummaryJson: null,
      afterSummaryJson: { password: "unsafe" },
      result: "FAILURE",
      errorCode: "ADMIN_SIGN_IN_REJECTED",
      createdAt: "2026-10-05T00:00:00.000Z",
      cookie: "unsafe",
    };
    expect(parseAdminAuditEvent(event)).toMatchObject({ afterSummaryJson: {} });
    expect(JSON.stringify(parseAdminAuditEvent(event))).not.toContain("unsafe");
    expect(parseAdminAuditEvent({ ...event, errorCode: "provider-secret-message" })).toBeNull();
    expect(parseAdminAuditEvent({ ...event, reason: "token=unsafe" })).toBeNull();
    expect(parseAdminAuditEvent({ ...event, actorAdminId: event.id })).toBeNull();
    expect(parseAdminAuditEvent({ ...event, result: "SUCCESS", errorCode: null })).toBeNull();
  });
});
