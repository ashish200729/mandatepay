import { describe, expect, it } from "vitest";
import {
  AdminMandateQuerySchema,
  AdminOverviewQuerySchema,
  AdminPaymentQuerySchema,
  AdminUserQuerySchema,
  AdminWebhookQuerySchema,
  buildAdminCsv,
  checkoutEligibility,
  parseAdminMandate,
  parseAdminPayment,
  parseAdminUser,
  parseAdminWebhook,
  webhookErrorCode,
} from "../src/admin-operations.js";

describe("admin operations contracts", () => {
  it("bounds list filters, rejects unknown keys and unpaired dates", () => {
    expect(AdminUserQuerySchema.parse({ limit: "2" }).limit).toBe(2);
    expect(AdminOverviewQuerySchema.parse({}).from).toBeUndefined();
    for (const value of [
      { limit: 101 },
      { limit: 0 },
      { secret: "private" },
      { from: "2026-10-05T00:00:00Z" },
      { from: "2025-01-01T00:00:00Z", to: "2026-10-05T00:00:00Z" },
      { q: "x".repeat(201) },
    ])
      expect(AdminUserQuerySchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    expect(AdminMandateQuerySchema.safeParse({ status: "UNKNOWN" }).success).toBe(false);
    expect(AdminPaymentQuerySchema.safeParse({ amountMin: 20, amountMax: 10 }).success).toBe(false);
    expect(AdminWebhookQuerySchema.safeParse({ eventType: "lowercase" }).success).toBe(false);
  });

  it("neutralizes formula-leading CSV cells and reports truncation", () => {
    const csv = buildAdminCsv(
      ["id", "name"],
      [
        { id: "abc", name: "=SUM(1)" },
        { id: "def", name: 'quoted,"value"' },
      ],
      true,
    );
    expect(csv).toContain('"\'=SUM(1)"');
    expect(csv).toContain('"quoted,""value"""');
    expect(csv).toContain("TRUNCATED_AT_1000");
    expect(csv).not.toMatch(/(?:^|,)=SUM/u);
  });

  it("projects safe DTOs and drops prompts, payloads and credential-like text", () => {
    expect(
      parseAdminUser({
        id: "11111111-1111-4111-8111-111111111111",
        name: "Ada",
        email: "ada@example.test",
        emailVerified: true,
        autonomousPurchasingEnabled: false,
        createdAt: "2026-10-06T00:00:00.000Z",
        updatedAt: "2026-10-06T00:00:00.000Z",
        activeMandateCount: 1,
        proposalCount: 2,
        capturedGrossMinor: 100,
        lastActivityAt: "2026-10-06T00:00:00.000Z",
        lastActivityBasis: "observed_activity_proxy",
        accessStatus: "unavailable",
        accessStatusReason: "Account disablement is not available until Phase 5.",
        password: "never",
      }),
    ).toMatchObject({ email: "ada@example.test", accessStatus: "unavailable" });
    expect(
      parseAdminMandate({
        id: "11111111-1111-4111-8111-111111111111",
        owner: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Ada",
          email: "ada@example.test",
        },
        title: "Headphones",
        status: "ACTIVE",
        version: 1,
        activeVersionId: "11111111-1111-4111-8111-111111111112",
        currency: "USD",
        autoSpendLimitMinor: 1000,
        transactionLimitMinor: 2000,
        dailyLimitMinor: null,
        weeklyLimitMinor: null,
        monthlyLimitMinor: null,
        spendTimeZone: "UTC",
        startsAt: "2026-10-01T00:00:00.000Z",
        expiresAt: "2026-11-01T00:00:00.000Z",
        effectiveExpired: false,
        rules: { originalPrompt: "secret prompt", title: "Headphones" },
        relatedProposalCount: 1,
        createdAt: "2026-10-06T00:00:00.000Z",
        updatedAt: "2026-10-06T00:00:00.000Z",
        originalPrompt: "Buy anything secretly",
      }),
    ).toMatchObject({ title: "Headphones", rules: null });
    const webhook = parseAdminWebhook({
      id: "11111111-1111-4111-8111-111111111111",
      providerEventId: "WH-1",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      signatureVerified: true,
      status: "FAILED",
      attempts: 5,
      receivedAt: "2026-10-06T00:00:00.000Z",
      processedAt: null,
      updatedAt: "2026-10-06T00:00:00.000Z",
      nextAttemptAt: null,
      leaseExpiresAt: null,
      stale: false,
      retryEligible: false,
      exhausted: true,
      errorCode: "RECOVERY_EXHAUSTED",
      paymentId: null,
      orderId: null,
      refundId: null,
      payload: { secret: "never" },
      lastError: "password=never",
    });
    expect(webhook).toMatchObject({ errorCode: "RECOVERY_EXHAUSTED", attempts: 5 });
    expect(JSON.stringify(webhook)).not.toMatch(/password|payload|never/u);
    expect(parseAdminPayment({ id: "x", token: "private" })).toBeNull();
  });

  it("maps webhook errors to closed codes and labels checkout eligibility as recorded-only", () => {
    expect(webhookErrorCode("timeout from provider", false)).toBe("WEBHOOK_TIMEOUT");
    expect(webhookErrorCode("password=secret timeout", false)).toBe("WEBHOOK_TIMEOUT");
    expect(webhookErrorCode("anything else", true)).toBe("RECOVERY_EXHAUSTED");
    expect(
      checkoutEligibility({
        source: "demo",
        isSample: false,
        status: "AUTHORIZED",
        expiresAt: null,
        asOf: new Date("2026-10-06T00:00:00Z"),
      }),
    ).toMatchObject({
      checkoutEligible: true,
      checkoutEligibilityNote: expect.stringContaining("does not authorize payment execution"),
    });
  });
});
