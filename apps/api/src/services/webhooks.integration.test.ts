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
    captureId = "CAPTURE-" + suffix;
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

  it("settles a refund whose PayPal response supplies a capture link and offset timestamp", async () => {
    const local = await database.refund.create({
      data: {
        paymentId,
        userId,
        amount: 500n,
        currency: "USD",
        status: "SUBMITTED",
        idempotencyKey: "linked-refund-" + randomUUID(),
      },
    });
    const paypal = fakePayPal();
    const refundId = "REFUND-" + randomUUID();
    paypal.getRefund = async () => ({
      id: refundId,
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "5.00" },
      invoice_id: local.id,
      create_time: "2026-10-03T23:00:06-07:00",
      links: [
        { rel: "up", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}` },
      ],
    });
    paypal.getCapture = async () => ({
      id: captureId,
      status: "PARTIALLY_REFUNDED",
      amount: { currency_code: "USD", value: "12.34" },
      custom_id: proposalId,
      supplementary_data: { related_ids: { order_id: orderId } },
    });
    const refundService = createPayPalWebhookService(database, paypal);
    const event = {
      id: "WH-LINKED-REFUND-" + randomUUID(),
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: { id: refundId },
    };
    expect(
      (await refundService.handle({ headers, rawBody: JSON.stringify(event) })).statusCode,
    ).toBe(200);
    expect(
      (await refundService.handle({ headers, rawBody: JSON.stringify(event) })).statusCode,
    ).toBe(200);
    const result = await database.refund.findUniqueOrThrow({ where: { id: local.id } });
    expect(result.status).toBe("COMPLETED");
    expect(result.paypalRefundId).toBe(refundId);
    expect(result.settledAt?.toISOString()).toBe("2026-10-04T06:00:06.000Z");
    expect((await database.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(
      "PARTIALLY_REFUNDED",
    );
    expect(
      await database.auditEvent.count({
        where: { entityId: paymentId, eventType: "REFUND_COMPLETED" },
      }),
    ).toBe(1);
  });

  it("serializes concurrent duplicate claims through the database event lock", async () => {
    const eventId = "WEBHOOK-CONCURRENT-" + randomUUID();
    const rawBody = JSON.stringify({ id: eventId, event_type: "UNKNOWN.EVENT", resource: {} });
    const results = await Promise.all([
      service.handle({ rawBody, headers }),
      service.handle({ rawBody, headers }),
    ]);
    expect(results.some((result) => result.statusCode === 200)).toBe(true);
    expect(results.every((result) => [200, 503].includes(result.statusCode))).toBe(true);
    // A concurrently processing lease asks PayPal to retry rather than
    // acknowledging work before it has committed.
    expect((await service.handle({ rawBody, headers })).statusCode).toBe(200);
    expect(await database.webhookInbox.count({ where: { providerEventId: eventId } })).toBe(1);
  });
});

describe("PayPal webhook provider-side outcomes", () => {
  let database: DatabaseClient;
  let ownerId = "";

  beforeAll(async () => {
    database = createPrismaClient(databaseUrl);
    const user = await database.user.create({
      data: {
        email: `webhook-outcomes-${randomUUID()}@mandatepay.local`,
        name: "Webhook outcomes",
      },
    });
    ownerId = user.id;
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  async function fixture(status: PaymentStatus, options: { captured?: boolean } = {}) {
    const suffix = randomUUID();
    const mandate = await new MandateRepository(database).create({
      userId: ownerId,
      title: "Webhook outcome mandate",
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
        externalId: "demo-webhook-outcome-" + suffix,
        title: "Demo product",
        brand: "Demo",
        category: "Test",
        condition: "NEW",
        price: 1_234n,
        currency: "USD",
        merchant: "Mandate Demo Store",
        metadata: { externalId: "demo-webhook-outcome-" + suffix },
      },
    });
    const captured = options.captured ?? false;
    const proposal = await database.purchaseProposal.create({
      data: {
        userId: ownerId,
        mandateId: mandate.id,
        mandateVersionId: mandate.activeVersionId!,
        productSnapshotId: product.id,
        quantity: 1,
        subtotal: 1_234n,
        shipping: 0n,
        tax: 0n,
        total: 1_234n,
        currency: "USD",
        status: captured
          ? ProposalStatus.COMPLETED
          : status === PaymentStatus.CAPTURE_PENDING
            ? ProposalStatus.PAYMENT_PENDING
            : ProposalStatus.PAYPAL_ORDER_CREATED,
        proposalFingerprint: "webhook-outcome-fingerprint-" + suffix,
        idempotencyKey: "webhook-outcome-proposal-" + suffix,
      },
    });
    const order = "ORDER-OUTCOME-" + suffix;
    const capture = "CAP-" + suffix.replaceAll("-", "").slice(0, 20);
    const payment = await database.payment.create({
      data: {
        userId: ownerId,
        mandateId: mandate.id,
        proposalId: proposal.id,
        paypalOrderId: order,
        ...(captured ? { paypalCaptureId: capture, capturedAt: new Date() } : {}),
        amount: 1_234n,
        currency: "USD",
        status,
        idempotencyKey: "webhook-outcome-payment-" + suffix,
      },
    });
    const reservation = await database.spendReservation.create({
      data: {
        mandateId: mandate.id,
        mandateVersionId: mandate.activeVersionId!,
        proposalId: proposal.id,
        amount: 1_234n,
        currency: "USD",
        window: "TRANSACTION",
        windowStart: new Date(Date.now() - 60_000),
        windowEnd: new Date(Date.now() + 86_400_000),
        status: captured ? ReservationStatus.CONSUMED : ReservationStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return { payment, proposal, reservation, order, capture };
  }

  function provider(input: {
    order: string;
    paymentId: string;
    proposalId: string;
    capture: Record<string, unknown>;
    refund?: Record<string, unknown>;
    orderCaptures?: readonly unknown[];
  }) {
    return {
      verifyWebhook: async () => true,
      getOrder: async () => ({
        id: input.order,
        status: "COMPLETED" as const,
        links: [],
        approvalUrl: null,
        purchase_units: [
          {
            reference_id: input.paymentId,
            custom_id: input.proposalId,
            amount: { currency_code: "USD" as const, value: "12.34" },
            payments: { captures: input.orderCaptures ?? [input.capture] },
          },
        ],
      }),
      getCapture: async () => input.capture,
      getRefund: async () => input.refund,
    } as unknown as PayPalClient;
  }

  function completedCapture(id: string, proposalId: string, overrides = {}) {
    return {
      id,
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "12.34" },
      custom_id: proposalId,
      create_time: "2026-10-02T12:00:00Z",
      ...overrides,
    };
  }

  it("records a refund issued outside MandatePay once, after an authoritative re-fetch", async () => {
    const data = await fixture(PaymentStatus.COMPLETED, { captured: true });
    const refundId = "REFUND-DASHBOARD-" + randomUUID();
    const paypal = provider({
      order: data.order,
      paymentId: data.payment.id,
      proposalId: data.proposal.id,
      capture: completedCapture(data.capture, data.proposal.id, {
        status: "PARTIALLY_REFUNDED",
        supplementary_data: { related_ids: { order_id: data.order } },
      }),
      refund: {
        id: refundId,
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "3.00" },
        create_time: "2026-10-03T10:00:00Z",
        links: [
          {
            rel: "up",
            href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${data.capture}`,
          },
        ],
      },
    });
    const service = createPayPalWebhookService(database, paypal);
    const delivery = (id: string) =>
      service.handle({
        headers,
        rawBody: JSON.stringify({
          id,
          event_type: "PAYMENT.CAPTURE.REFUNDED",
          resource: { id: refundId },
        }),
      });
    expect((await delivery("WH-DASH-" + randomUUID())).statusCode).toBe(200);
    // A second, distinct event for the same provider refund is not double counted.
    expect((await delivery("WH-DASH-" + randomUUID())).statusCode).toBe(200);
    const refunds = await database.refund.findMany({ where: { paymentId: data.payment.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      paypalRefundId: refundId,
      amount: 300n,
      status: "COMPLETED",
      providerInitiated: true,
    });
    expect(refunds[0]?.settledAt?.toISOString()).toBe("2026-10-03T10:00:00.000Z");
    expect(
      (await database.payment.findUniqueOrThrow({ where: { id: data.payment.id } })).status,
    ).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(
      await database.auditEvent.count({
        where: { entityId: data.payment.id, eventType: AuditEventType.REFUND_COMPLETED },
      }),
    ).toBe(1);
  });

  it("ignores an outside refund that would exceed the captured amount", async () => {
    const data = await fixture(PaymentStatus.COMPLETED, { captured: true });
    const refundId = "REFUND-OVER-" + randomUUID();
    const service = createPayPalWebhookService(
      database,
      provider({
        order: data.order,
        paymentId: data.payment.id,
        proposalId: data.proposal.id,
        capture: completedCapture(data.capture, data.proposal.id),
        refund: {
          id: refundId,
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "12.35" },
          capture_id: data.capture,
          create_time: "2026-10-03T10:00:00Z",
        },
      }),
    );
    const result = await service.handle({
      headers,
      rawBody: JSON.stringify({
        id: "WH-OVER-" + randomUUID(),
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        resource: { id: refundId, capture_id: data.capture },
      }),
    });
    expect(result.statusCode).toBe(200);
    expect(await database.refund.count({ where: { paymentId: data.payment.id } })).toBe(0);
  });

  it("records a capture reversal (chargeback) with an audit event", async () => {
    const data = await fixture(PaymentStatus.COMPLETED, { captured: true });
    const reversalId = "REVERSAL-" + randomUUID().slice(0, 20);
    const service = createPayPalWebhookService(
      database,
      provider({
        order: data.order,
        paymentId: data.payment.id,
        proposalId: data.proposal.id,
        capture: completedCapture(data.capture, data.proposal.id, {
          status: "REFUNDED",
          supplementary_data: { related_ids: { order_id: data.order } },
        }),
        refund: {
          id: reversalId,
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "12.34" },
          capture_id: data.capture,
          create_time: "2026-10-04T10:00:00Z",
        },
      }),
    );
    const event = {
      id: "WH-REVERSED-" + randomUUID(),
      event_type: "PAYMENT.CAPTURE.REVERSED",
      resource: { id: reversalId, capture_id: data.capture },
    };
    expect((await service.handle({ headers, rawBody: JSON.stringify(event) })).statusCode).toBe(
      200,
    );
    const payment = await database.payment.findUniqueOrThrow({ where: { id: data.payment.id } });
    expect(payment.status).toBe(PaymentStatus.REVERSED);
    expect(payment.providerStatusReason).toBe("CAPTURE_REVERSED");
    expect(
      await database.auditEvent.count({
        where: { entityId: data.payment.id, eventType: AuditEventType.PAYMENT_REVERSED },
      }),
    ).toBe(1);
  });

  it("keeps a PAYMENT.CAPTURE.PENDING capture held with its reason and reservation", async () => {
    const data = await fixture(PaymentStatus.CAPTURE_PENDING);
    const capture = completedCapture(data.capture, data.proposal.id, {
      status: "PENDING",
      status_details: { reason: "PENDING_REVIEW" },
    });
    const service = createPayPalWebhookService(
      database,
      provider({
        order: data.order,
        paymentId: data.payment.id,
        proposalId: data.proposal.id,
        capture,
      }),
    );
    const result = await service.handle({
      headers,
      rawBody: JSON.stringify({
        id: "WH-PENDING-" + randomUUID(),
        event_type: "PAYMENT.CAPTURE.PENDING",
        resource: {
          id: data.capture,
          supplementary_data: { related_ids: { order_id: data.order } },
        },
      }),
    });
    expect(result.statusCode).toBe(200);
    const payment = await database.payment.findUniqueOrThrow({ where: { id: data.payment.id } });
    expect(payment).toMatchObject({
      status: PaymentStatus.CAPTURE_PENDING,
      paypalCaptureId: data.capture,
      providerStatusReason: "PENDING_REVIEW",
    });
    expect(
      (await database.spendReservation.findUniqueOrThrow({ where: { id: data.reservation.id } }))
        .status,
    ).toBe(ReservationStatus.ACTIVE);
  });

  it("settles a payment from CHECKOUT.ORDER.COMPLETED using the order's own capture", async () => {
    const data = await fixture(PaymentStatus.APPROVED);
    const service = createPayPalWebhookService(
      database,
      provider({
        order: data.order,
        paymentId: data.payment.id,
        proposalId: data.proposal.id,
        capture: completedCapture(data.capture, data.proposal.id),
      }),
    );
    const result = await service.handle({
      headers,
      rawBody: JSON.stringify({
        id: "WH-ORDER-COMPLETED-" + randomUUID(),
        event_type: "CHECKOUT.ORDER.COMPLETED",
        resource: { id: data.order },
      }),
    });
    expect(result.statusCode).toBe(200);
    const payment = await database.payment.findUniqueOrThrow({ where: { id: data.payment.id } });
    expect(payment.status).toBe(PaymentStatus.COMPLETED);
    expect(payment.paypalCaptureId).toBe(data.capture);
    expect(
      (await database.spendReservation.findUniqueOrThrow({ where: { id: data.reservation.id } }))
        .status,
    ).toBe(ReservationStatus.CONSUMED);
  });

  it("marks pending outcomes for the long schedule and failures for the short one", async () => {
    const data = await fixture(PaymentStatus.CAPTURE_PENDING);
    const pendingService = createPayPalWebhookService(
      database,
      provider({
        order: data.order,
        paymentId: data.payment.id,
        proposalId: data.proposal.id,
        // The order does not list this capture yet, so the binding is pending.
        capture: completedCapture("CAPTURE-NOT-ON-ORDER", data.proposal.id),
        orderCaptures: [{ id: "SOME-OTHER-CAPTURE" }],
      }),
    );
    const pendingEvent = "WH-AWAIT-" + randomUUID();
    const pending = await pendingService.handle({
      headers,
      rawBody: JSON.stringify({
        id: pendingEvent,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
          id: "CAPTURE-NOT-ON-ORDER",
          supplementary_data: { related_ids: { order_id: data.order } },
        },
      }),
    });
    expect(pending.statusCode).toBe(202);
    expect(
      await database.webhookInbox.findFirstOrThrow({ where: { providerEventId: pendingEvent } }),
    ).toMatchObject({ status: "FAILED", awaitingProvider: true });

    const failing = {
      verifyWebhook: async () => true,
      getCapture: async () => {
        throw new Error("PayPal unreachable");
      },
    } as unknown as PayPalClient;
    const failedEvent = "WH-FAILED-" + randomUUID();
    const failed = await createPayPalWebhookService(database, failing).handle({
      headers,
      rawBody: JSON.stringify({
        id: failedEvent,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: { id: "CAPTURE-ANY" },
      }),
    });
    expect(failed.statusCode).toBe(503);
    expect(
      await database.webhookInbox.findFirstOrThrow({ where: { providerEventId: failedEvent } }),
    ).toMatchObject({ status: "FAILED", awaitingProvider: false });
    // Leave no due rows behind for the globally scanning recovery-worker tests.
    await database.webhookInbox.updateMany({
      where: { providerEventId: { in: [pendingEvent, failedEvent] } },
      data: { status: "IGNORED", nextAttemptAt: null },
    });
  });
});
