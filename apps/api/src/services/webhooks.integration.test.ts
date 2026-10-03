import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuditEventType,
  MandateRepository,
  PaymentStatus,
  ProposalStatus,
  ReservationStatus,
  createPrismaClient,
  type DatabaseClient,
} from "@mandatepay/database";
import { createPayPalWebhookService } from "./webhooks.js";
import type { PayPalClient } from "@mandatepay/paypal";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) {
  throw new Error("Webhook integration requires a dedicated TEST_DATABASE_URL ending in _test.");
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL === databaseUrl) {
  throw new Error("Webhook integration cannot use DATABASE_URL.");
}

const headers = {
  "paypal-transmission-id": "integration-transmission-1",
  "paypal-transmission-time": "2026-10-02T12:00:00Z",
  "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-transmission-sig": "integration-signature",
};

function fakePayPal(captureAmount = "12.34", captureStatus = "COMPLETED") {
  return {
    verifyWebhook: async () => true,
    getOrder: async () => ({
      id: orderId,
      status: "COMPLETED" as const,
      links: [],
      approvalUrl: null,
      purchase_units: [
        {
          reference_id: paymentId,
          custom_id: proposalId,
          amount: { currency_code: "USD" as const, value: "12.34" },
          payments: { captures: [{ id: captureId }] },
        },
      ],
    }),
    getCapture: async () => ({
      id: captureId,
      status: captureStatus as "COMPLETED" | "DECLINED" | "PENDING",
      amount: { currency_code: "USD" as const, value: captureAmount },
      custom_id: proposalId,
      create_time: "2026-10-02T12:00:00Z",
    }),
    getRefund: async () => ({
      id: "refund-integration",
      status: "COMPLETED" as const,
      amount: { currency_code: "USD" as const, value: "5.00" },
      create_time: "2026-10-02T12:30:00Z",
    }),
  } as unknown as PayPalClient;
}

let orderId = "";
let captureId = "";
let webhookEventId = "";
let proposalId = "";
let paymentId = "";

describe("PayPal webhook durable integration", () => {
  let database: DatabaseClient;
  let service: ReturnType<typeof createPayPalWebhookService>;
  let userId = "";
  let reservationId = "";

  beforeAll(async () => {
    database = createPrismaClient(databaseUrl);
    const suffix = randomUUID();
    orderId = "ORDER-INTEGRATION-" + suffix;
    captureId = "CAPTURE-INTEGRATION-" + suffix;
    webhookEventId = "WEBHOOK-INTEGRATION-" + suffix;
    const user = await database.user.create({
      data: { email: `webhook-${suffix}@mandatepay.local`, name: "Webhook integration" },
    });
    userId = user.id;
    const mandate = await new MandateRepository(database).create({
      userId,
      title: "Webhook mandate",
      originalPrompt: "Buy one demo item.",
      status: "ACTIVE",
      currency: "USD",
      autoSpendLimit: 20_000n,
      transactionLimit: 20_000n,
      dailyLimit: 50_000n,
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const product = await database.productSnapshot.create({
      data: {
        source: "demo",
        externalId: "demo-webhook-product-" + suffix,
        title: "Demo product",
        brand: "Demo",
        category: "Test",
        condition: "NEW",
        price: 1_234n,
        currency: "USD",
        merchant: "Mandate Demo Store",
        metadata: { externalId: "demo-webhook-product-" + suffix },
      },
    });
    const proposal = await database.purchaseProposal.create({
      data: {
        userId,
        mandateId: mandate.id,
        mandateVersionId: mandate.activeVersionId!,
        productSnapshotId: product.id,
        quantity: 1,
        subtotal: 1_234n,
        shipping: 0n,
        tax: 0n,
        total: 1_234n,
        currency: "USD",
        status: ProposalStatus.AUTHORIZED,
        proposalFingerprint: "webhook-integration-fingerprint-" + suffix,
        idempotencyKey: "webhook-proposal-" + suffix,
      },
    });
    proposalId = proposal.id;
    const payment = await database.payment.create({
      data: {
        userId,
        mandateId: mandate.id,
        proposalId,
        paypalOrderId: orderId,
        amount: 1_234n,
        currency: "USD",
        status: PaymentStatus.APPROVED,
        idempotencyKey: "webhook-payment-" + suffix,
      },
    });
    paymentId = payment.id;
    const reservation = await database.spendReservation.create({
      data: {
        mandateId: mandate.id,
        mandateVersionId: mandate.activeVersionId!,
        proposalId,
        amount: 1_234n,
        currency: "USD",
        window: "TRANSACTION",
        windowStart: new Date(Date.now() - 60_000),
        windowEnd: new Date(Date.now() + 86_400_000),
        status: ReservationStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    reservationId = reservation.id;
    service = createPayPalWebhookService(database, fakePayPal());
    expect(payment.id).toBeTruthy();
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it("verifies, deduplicates, and commits capture/payment/proposal/reservation/audit together", async () => {
    const rawBody = JSON.stringify({
      id: webhookEventId,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      create_time: "2026-10-02T12:00:00Z",
      resource: {
        id: captureId,
        supplementary_data: { related_ids: { order_id: orderId, capture_id: captureId } },
      },
    });

    const first = await service.handle({ rawBody, headers });
    const second = await service.handle({ rawBody, headers });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const payment = await database.payment.findFirstOrThrow({ where: { proposalId } });
    const proposal = await database.purchaseProposal.findUniqueOrThrow({
      where: { id: proposalId },
    });
    const reservation = await database.spendReservation.findUniqueOrThrow({
      where: { id: reservationId },
    });
    expect(payment.status).toBe(PaymentStatus.COMPLETED);
    expect(payment.paypalCaptureId).toBe(captureId);
    expect(payment.capturedAt?.toISOString()).toBe("2026-10-02T12:00:00.000Z");
    expect(proposal.status).toBe(ProposalStatus.COMPLETED);
    expect(reservation.status).toBe(ReservationStatus.CONSUMED);
    expect(
      await database.auditEvent.count({
        where: { entityId: payment.id, eventType: AuditEventType.PAYMENT_CAPTURED },
      }),
    ).toBe(1);
    expect(await database.webhookInbox.count({ where: { providerEventId: webhookEventId } })).toBe(
      1,
    );
  });

  it("rejects unsigned delivery without creating inbox rows", async () => {
    const before = await database.webhookInbox.count({ where: { providerEventId: "UNSIGNED-1" } });
    const result = await service.handle({
      rawBody: JSON.stringify({
        id: "UNSIGNED-1",
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {},
      }),
      headers: {},
    });
    expect(result.statusCode).toBe(400);
    expect(await database.webhookInbox.count({ where: { providerEventId: "UNSIGNED-1" } })).toBe(
      before,
    );
  });

  it("does not complete an owned payment when provider amount mismatches", async () => {
    const mismatchService = createPayPalWebhookService(database, fakePayPal("99.99"));
    const rawBody = JSON.stringify({
      id: "WEBHOOK-MISMATCH-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      create_time: "2026-10-02T12:00:00Z",
      resource: {
        id: "CAPTURE-MISMATCH",
        supplementary_data: { related_ids: { order_id: orderId, capture_id: "CAPTURE-MISMATCH" } },
      },
    });
    const result = await mismatchService.handle({ rawBody, headers });
    expect(result.statusCode).toBe(200);
    const payment = await database.payment.findFirstOrThrow({ where: { proposalId } });
    expect(payment.status).toBe(PaymentStatus.COMPLETED);
    expect(payment.paypalCaptureId).toBe(captureId);
  });

  it("reclaims an expired processing lease and does not acknowledge an active lease", async () => {
    const expiredId = "WEBHOOK-LEASE-EXPIRED-" + randomUUID();
    const expired = await database.webhookInbox.create({
      data: {
        provider: "paypal",
        providerEventId: expiredId,
        eventType: "UNKNOWN.EVENT",
        signatureVerified: true,
        payload: { id: expiredId, event_type: "UNKNOWN.EVENT", resource: {} },
        status: "PROCESSING",
        attempts: 1,
      },
    });
    await database.webhookInbox.update({
      where: { id: expired.id },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const reclaimed = await service.handle({
      rawBody: JSON.stringify({ id: expiredId, event_type: "UNKNOWN.EVENT", resource: {} }),
      headers,
    });
    expect(reclaimed.statusCode).toBe(200);
    expect(
      (await database.webhookInbox.findUniqueOrThrow({ where: { id: expired.id } })).status,
    ).toBe("IGNORED");

    const activeId = "WEBHOOK-LEASE-ACTIVE-" + randomUUID();
    await database.webhookInbox.create({
      data: {
        provider: "paypal",
        providerEventId: activeId,
        eventType: "UNKNOWN.EVENT",
        signatureVerified: true,
        payload: { id: activeId, event_type: "UNKNOWN.EVENT", resource: {} },
        status: "PROCESSING",
        attempts: 1,
      },
    });
    const active = await service.handle({
      rawBody: JSON.stringify({ id: activeId, event_type: "UNKNOWN.EVENT", resource: {} }),
      headers,
    });
    expect(active.statusCode).toBe(503);
  });

  it("serializes concurrent duplicate claims through the database event lock", async () => {
    const eventId = "WEBHOOK-CONCURRENT-" + randomUUID();
    const rawBody = JSON.stringify({ id: eventId, event_type: "UNKNOWN.EVENT", resource: {} });
    const results = await Promise.all([
      service.handle({ rawBody, headers }),
      service.handle({ rawBody, headers }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 200]);
    expect(await database.webhookInbox.count({ where: { providerEventId: eventId } })).toBe(1);
  });
});
