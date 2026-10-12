import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AuditEventType,
  MandateRepository,
  PaymentProfileStatus,
  PaymentSource,
  PaymentStatus,
  ProposalStatus,
  ReservationStatus,
  createPrismaClient,
  type DatabaseClient,
} from "@mandatepay/database";
import {
  PayPalProviderError,
  type CreateVaultOrderInput,
  type PayPalCapture,
  type PayPalOrder,
} from "@mandatepay/paypal";
import { replayUnboundVaultOrder, type PayPalGateway } from "../services/payments.js";
import { unboundVaultPaymentWhere } from "../services/system-health.js";
import { createVaultCipher } from "../services/vault-crypto.js";
import { PAYMENT_RECONCILE_WORKER, PaymentReconcileWorker } from "./payment-reconcile.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) {
  throw new Error("Payment reconcile integration requires a dedicated TEST_DATABASE_URL.");
}

const STALE = new Date(Date.now() - 20 * 60_000);

describe("payment reconcile worker", () => {
  let database: DatabaseClient;
  let ownerId = "";
  const orders = new Map<string, () => PayPalOrder>();
  const captureOrder = vi.fn<(orderId: string, requestId: string) => Promise<PayPalCapture>>();
  const createOrder = vi.fn<PayPalGateway["createOrder"]>();
  const createVaultOrder = vi.fn<(input: CreateVaultOrderInput) => Promise<PayPalOrder>>();
  const vault = createVaultCipher(randomBytes(32).toString("base64"))!;
  const gateway: PayPalGateway = {
    createOrder,
    captureOrder,
    createVaultOrder,
    getOrder: async (orderId) => {
      const order = orders.get(orderId);
      if (!order) throw new PayPalProviderError("UPSTREAM_UNAVAILABLE", 503, { retryable: true });
      return order();
    },
  };

  beforeAll(async () => {
    database = createPrismaClient(databaseUrl);
    const user = await database.user.create({
      data: { email: `reconcile-${randomUUID()}@mandatepay.local`, name: "Reconcile worker" },
    });
    ownerId = user.id;
  });

  const heldPaymentIds: string[] = [];

  afterAll(async () => {
    // Close deliberately held fixtures so they never appear as System health backlog later.
    if (heldPaymentIds.length > 0) {
      const held = await database.payment.findMany({
        where: { id: { in: heldPaymentIds } },
        select: { proposalId: true },
      });
      const proposalIds = held.map((payment) => payment.proposalId);
      await database.spendReservation.updateMany({
        where: { proposalId: { in: proposalIds } },
        data: { status: ReservationStatus.RELEASED, releasedAt: new Date() },
      });
      await database.purchaseProposal.updateMany({
        where: { id: { in: proposalIds } },
        data: { status: ProposalStatus.FAILED },
      });
      await database.payment.updateMany({
        where: { id: { in: heldPaymentIds } },
        data: { status: PaymentStatus.FAILED, failureCode: "TEST_FIXTURE_CLOSED" },
      });
    }
    await database.$disconnect();
  });

  /** A user who saved PayPal and turned on autonomous purchasing. */
  async function vaultUser(label: string) {
    const user = await database.user.create({
      data: {
        email: `reconcile-vault-${label}-${randomUUID()}@mandatepay.local`,
        name: "Reconcile vault " + label,
        globalAutonomousPurchasingEnabled: true,
      },
    });
    const tokenId = "VTOK" + randomUUID().replaceAll("-", "").slice(0, 20);
    await database.paymentProfile.create({
      data: {
        userId: user.id,
        status: PaymentProfileStatus.ACTIVE,
        paypalVaultIdEncrypted: vault.encrypt(user.id, tokenId),
        paypalVaultIdHash: vault.hash(tokenId),
        activatedAt: new Date(),
        consentVersion: "test",
        consentedAt: new Date(),
      },
    });
    return { userId: user.id, tokenId };
  }

  function vaultOrder(input: CreateVaultOrderInput): PayPalOrder {
    return {
      id: "ORDER-V-" + input.referenceId,
      status: "COMPLETED",
      links: [],
      approvalUrl: null,
      purchase_units: [
        {
          reference_id: input.referenceId,
          custom_id: input.customId,
          amount: { currency_code: "USD", value: "12.34" },
          payments: {
            captures: [
              {
                id: "CAP-V-" + input.referenceId.replaceAll("-", "").slice(0, 16),
                status: "COMPLETED",
                amount: { currency_code: "USD", value: "12.34" },
                custom_id: input.customId,
                create_time: "2026-10-12T10:00:00Z",
              },
            ],
          },
        },
      ],
    };
  }

  function vaultWorker(userIds: string[], client: DatabaseClient = database) {
    return new PaymentReconcileWorker(client, gateway, {
      staleAfterMs: 10 * 60_000,
      userIds,
      vault,
    });
  }

  async function holdState(paymentId: string, reservationId: string) {
    return {
      payment: (await database.payment.findUniqueOrThrow({ where: { id: paymentId } })).status,
      reservation: (
        await database.spendReservation.findUniqueOrThrow({ where: { id: reservationId } })
      ).status,
    };
  }

  async function fixture(input: {
    status: PaymentStatus;
    updatedAt?: Date;
    reservationExpiresAt?: Date;
    /** Autonomous payment whose create-order outcome was unknown: no PayPal order id. */
    unboundVault?: { userId: string; createdAt?: Date };
  }) {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const userId = input.unboundVault?.userId ?? ownerId;
    const mandate = await new MandateRepository(database).create({
      userId,
      title: "Reconcile mandate",
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
        externalId: "demo-reconcile-" + suffix,
        title: "Demo product",
        brand: "Demo",
        category: "Test",
        condition: "NEW",
        price: 1_234n,
        currency: "USD",
        merchant: "Mandate Demo Store",
        metadata: { externalId: "demo-reconcile-" + suffix },
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
        status:
          input.status === PaymentStatus.CAPTURE_PENDING
            ? ProposalStatus.PAYMENT_PENDING
            : ProposalStatus.PAYPAL_ORDER_CREATED,
        proposalFingerprint: "reconcile-fingerprint-" + suffix,
        idempotencyKey: "reconcile-proposal-" + suffix,
      },
    });
    const orderId = "ORDER-" + suffix;
    const payment = await database.payment.create({
      data: {
        userId,
        mandateId: mandate.id,
        proposalId: proposal.id,
        paypalOrderId: input.unboundVault ? null : orderId,
        paymentSource: input.unboundVault ? PaymentSource.VAULT : PaymentSource.CHECKOUT,
        paypalOrderRequestId: randomUUID(),
        paypalCaptureRequestId: randomUUID(),
        amount: 1_234n,
        currency: "USD",
        status: input.status,
        idempotencyKey: "reconcile-payment-" + suffix,
      },
    });
    const expiresAt = input.reservationExpiresAt ?? new Date(Date.now() + 86_400_000);
    const reservation = await database.spendReservation.create({
      data: {
        mandateId: mandate.id,
        mandateVersionId: mandate.activeVersionId!,
        proposalId: proposal.id,
        amount: 1_234n,
        currency: "USD",
        window: "TRANSACTION",
        windowStart: new Date(Date.now() - 60 * 60_000),
        windowEnd: expiresAt,
        status: ReservationStatus.ACTIVE,
        expiresAt,
      },
    });
    if (input.unboundVault?.createdAt) {
      await database.$executeRaw`UPDATE "Payment" SET "createdAt" = ${input.unboundVault.createdAt} WHERE id = ${payment.id}`;
    }
    if (input.updatedAt) {
      await database.$executeRaw`UPDATE "Payment" SET "updatedAt" = ${input.updatedAt} WHERE id = ${payment.id}`;
    }
    const order = (status: PayPalOrder["status"], captures?: unknown[]): PayPalOrder => ({
      id: orderId,
      status,
      links: [],
      approvalUrl: null,
      purchase_units: [
        {
          reference_id: payment.id,
          custom_id: proposal.id,
          amount: { currency_code: "USD", value: "12.34" },
          ...(captures ? { payments: { captures: captures as never } } : {}),
        },
      ],
    });
    return { payment, proposal, reservation, orderId, order };
  }

  function worker(options: { staleAfterMs?: number } = {}) {
    return new PaymentReconcileWorker(database, gateway, {
      staleAfterMs: options.staleAfterMs ?? 10 * 60_000,
      userIds: [ownerId],
    });
  }

  it("settles, fails or returns stale captures using provider reads only", async () => {
    const completed = await fixture({ status: PaymentStatus.CAPTURE_PENDING, updatedAt: STALE });
    const captureId = "CAP-" + randomUUID().replaceAll("-", "").slice(0, 16);
    orders.set(completed.orderId, () =>
      completed.order("COMPLETED", [
        {
          id: captureId,
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "12.34" },
          custom_id: completed.proposal.id,
          create_time: "2026-10-03T23:00:06-07:00",
        },
      ]),
    );
    const approved = await fixture({ status: PaymentStatus.CAPTURE_PENDING, updatedAt: STALE });
    orders.set(approved.orderId, () => approved.order("APPROVED"));
    const voided = await fixture({ status: PaymentStatus.CAPTURE_PENDING, updatedAt: STALE });
    orders.set(voided.orderId, () => voided.order("VOIDED"));
    const unreachable = await fixture({ status: PaymentStatus.CAPTURE_PENDING, updatedAt: STALE });
    const recent = await fixture({ status: PaymentStatus.CAPTURE_PENDING });
    orders.set(recent.orderId, () => recent.order("APPROVED"));

    const result = await worker().runOnce();
    expect(result.captures).toMatchObject({
      completed: 1,
      failed: 1,
      returnedToPayer: 1,
      stillPending: 1,
      errors: 0,
    });
    expect(captureOrder).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();

    const settled = await database.payment.findUniqueOrThrow({
      where: { id: completed.payment.id },
    });
    expect(settled).toMatchObject({ status: PaymentStatus.COMPLETED, paypalCaptureId: captureId });
    expect(settled.capturedAt?.toISOString()).toBe("2026-10-04T06:00:06.000Z");
    expect(
      (
        await database.spendReservation.findUniqueOrThrow({
          where: { id: completed.reservation.id },
        })
      ).status,
    ).toBe(ReservationStatus.CONSUMED);

    const returned = await database.payment.findUniqueOrThrow({
      where: { id: approved.payment.id },
    });
    expect(returned).toMatchObject({
      status: PaymentStatus.APPROVED,
      providerStatusReason: "CAPTURE_NOT_CONFIRMED",
      paypalCaptureRequestId: approved.payment.paypalCaptureRequestId,
    });
    expect(
      (await database.purchaseProposal.findUniqueOrThrow({ where: { id: approved.proposal.id } }))
        .status,
    ).toBe(ProposalStatus.PAYPAL_ORDER_CREATED);

    const failed = await database.payment.findUniqueOrThrow({ where: { id: voided.payment.id } });
    expect(failed).toMatchObject({
      status: PaymentStatus.FAILED,
      failureCode: "PAYPAL_ORDER_VOIDED",
    });
    expect(
      (await database.spendReservation.findUniqueOrThrow({ where: { id: voided.reservation.id } }))
        .status,
    ).toBe(ReservationStatus.RELEASED);

    for (const untouched of [unreachable, recent]) {
      expect(
        (await database.payment.findUniqueOrThrow({ where: { id: untouched.payment.id } })).status,
      ).toBe(PaymentStatus.CAPTURE_PENDING);
      expect(
        (
          await database.spendReservation.findUniqueOrThrow({
            where: { id: untouched.reservation.id },
          })
        ).status,
      ).toBe(ReservationStatus.ACTIVE);
    }

    const heartbeat = await database.workerHeartbeat.findFirstOrThrow({
      where: { worker: PAYMENT_RECONCILE_WORKER },
      orderBy: { heartbeatAt: "desc" },
    });
    expect(heartbeat.outcome).toBe("SUCCEEDED");
  });

  it("releases expired unpaid holds but keeps every hold a capture may consume", async () => {
    const past = new Date(Date.now() - 60_000);
    const unpaid = await fixture({ status: PaymentStatus.APPROVED, reservationExpiresAt: past });
    const capturing = await fixture({
      status: PaymentStatus.CAPTURE_PENDING,
      reservationExpiresAt: past,
    });
    const result = await worker().runOnce();
    expect(result.reservationsReleased).toBe(1);
    expect(
      (await database.spendReservation.findUniqueOrThrow({ where: { id: unpaid.reservation.id } }))
        .status,
    ).toBe(ReservationStatus.EXPIRED);
    expect(
      (
        await database.spendReservation.findUniqueOrThrow({
          where: { id: capturing.reservation.id },
        })
      ).status,
    ).toBe(ReservationStatus.ACTIVE);
    expect(
      await database.auditEvent.count({
        where: {
          entityId: unpaid.reservation.id,
          eventType: AuditEventType.SPEND_RESERVATION_RELEASED,
        },
      }),
    ).toBe(1);
  });

  it("is safe to run concurrently: each outcome is recorded exactly once", async () => {
    const completed = await fixture({ status: PaymentStatus.CAPTURE_PENDING, updatedAt: STALE });
    const captureId = "CAP-" + randomUUID().replaceAll("-", "").slice(0, 16);
    orders.set(completed.orderId, () =>
      completed.order("COMPLETED", [
        {
          id: captureId,
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "12.34" },
          custom_id: completed.proposal.id,
          create_time: "2026-10-04T10:00:00Z",
        },
      ]),
    );
    const expired = await fixture({
      status: PaymentStatus.CREATED,
      reservationExpiresAt: new Date(Date.now() - 60_000),
    });
    await Promise.all([worker().runOnce(), worker().runOnce(), worker().runOnce()]);
    expect(
      (await database.payment.findUniqueOrThrow({ where: { id: completed.payment.id } })).status,
    ).toBe(PaymentStatus.COMPLETED);
    expect(
      await database.auditEvent.count({
        where: { entityId: completed.payment.id, eventType: AuditEventType.PAYMENT_CAPTURED },
      }),
    ).toBe(1);
    expect(
      await database.auditEvent.count({
        where: {
          entityId: expired.reservation.id,
          eventType: AuditEventType.SPEND_RESERVATION_RELEASED,
        },
      }),
    ).toBe(1);
    expect(captureOrder).not.toHaveBeenCalled();
  });

  it("replays an unbound Vault order with the same request ID until PayPal settles it", async () => {
    createVaultOrder.mockReset();
    const owner = await vaultUser("settle");
    const unbound = await fixture({
      status: PaymentStatus.CAPTURE_PENDING,
      updatedAt: STALE,
      unboundVault: { userId: owner.userId },
    });
    // The replay itself times out again: still unknown, nothing released.
    createVaultOrder.mockRejectedValueOnce(
      new PayPalProviderError("UPSTREAM_TIMEOUT", undefined, {
        retryable: true,
        unknownOutcome: true,
      }),
    );
    const first = await vaultWorker([owner.userId]).runOnce();
    expect(first.vaultReplays).toMatchObject({ stillPending: 1, completed: 0, held: 0 });
    expect(await holdState(unbound.payment.id, unbound.reservation.id)).toEqual({
      payment: PaymentStatus.CAPTURE_PENDING,
      reservation: ReservationStatus.ACTIVE,
    });

    createVaultOrder.mockImplementation(async (input) => vaultOrder(input));
    const second = await vaultWorker([owner.userId]).runOnce();
    expect(second.vaultReplays).toMatchObject({ completed: 1, failed: 0, held: 0, errors: 0 });
    expect(second).toMatchObject({ scanned: 1, claimed: 1, processed: 1, pending: 0 });
    expect(createVaultOrder).toHaveBeenCalledTimes(2);
    for (const [call] of createVaultOrder.mock.calls) {
      expect(call).toMatchObject({
        requestId: unbound.payment.paypalOrderRequestId,
        referenceId: unbound.payment.id,
        customId: unbound.proposal.id,
        vaultId: owner.tokenId,
        amountMinor: 1_234,
      });
    }
    expect(createOrder).not.toHaveBeenCalled();
    expect(captureOrder).not.toHaveBeenCalled();
    const settled = await database.payment.findUniqueOrThrow({ where: { id: unbound.payment.id } });
    expect(settled).toMatchObject({
      status: PaymentStatus.COMPLETED,
      paypalOrderId: "ORDER-V-" + unbound.payment.id,
    });
    expect(
      (await database.spendReservation.findUniqueOrThrow({ where: { id: unbound.reservation.id } }))
        .status,
    ).toBe(ReservationStatus.CONSUMED);
    expect(
      await database.auditEvent.count({
        where: {
          entityId: unbound.payment.id,
          eventType: AuditEventType.AUTONOMOUS_PAYMENT_COMPLETED,
        },
      }),
    ).toBe(1);
    const heartbeat = await database.workerHeartbeat.findFirstOrThrow({
      where: { worker: PAYMENT_RECONCILE_WORKER },
      orderBy: { heartbeatAt: "desc" },
    });
    expect(heartbeat.outcome).toBe("SUCCEEDED");

    // Settled payments are never replayed again.
    await vaultWorker([owner.userId]).runOnce();
    expect(createVaultOrder).toHaveBeenCalledTimes(2);
  });

  it("fails and releases the hold when the replay is definitively rejected", async () => {
    createVaultOrder.mockReset();
    const owner = await vaultUser("rejected");
    const unbound = await fixture({
      status: PaymentStatus.CAPTURE_PENDING,
      updatedAt: STALE,
      unboundVault: { userId: owner.userId },
    });
    createVaultOrder.mockRejectedValue(
      new PayPalProviderError("UPSTREAM_REQUEST_FAILED", 422, {
        details: { name: "UNPROCESSABLE_ENTITY", issue: "PAYEE_ACCOUNT_RESTRICTED", debugId: null },
      }),
    );
    const result = await vaultWorker([owner.userId]).runOnce();
    expect(result.vaultReplays).toMatchObject({ failed: 1, completed: 0, held: 0, errors: 0 });
    const failed = await database.payment.findUniqueOrThrow({ where: { id: unbound.payment.id } });
    expect(failed).toMatchObject({
      status: PaymentStatus.FAILED,
      failureCode: "PAYPAL_VAULT_ORDER_REJECTED:PAYEE_ACCOUNT_RESTRICTED",
    });
    expect(
      (await database.purchaseProposal.findUniqueOrThrow({ where: { id: unbound.proposal.id } }))
        .status,
    ).toBe(ProposalStatus.FAILED);
    expect(
      (await database.spendReservation.findUniqueOrThrow({ where: { id: unbound.reservation.id } }))
        .status,
    ).toBe(ReservationStatus.RELEASED);
    expect(
      await database.auditEvent.count({
        where: {
          entityId: unbound.reservation.id,
          eventType: AuditEventType.SPEND_RESERVATION_RELEASED,
        },
      }),
    ).toBe(1);
  });

  it("holds without calling PayPal when the method, switches or replay window no longer allow it", async () => {
    createVaultOrder.mockReset();
    createVaultOrder.mockImplementation(async (input) => vaultOrder(input));
    const revoked = await vaultUser("revoked");
    const revokedPayment = await fixture({
      status: PaymentStatus.CAPTURE_PENDING,
      updatedAt: STALE,
      unboundVault: { userId: revoked.userId },
    });
    await database.paymentProfile.update({
      where: { userId: revoked.userId },
      data: {
        status: PaymentProfileStatus.REVOKED,
        paypalVaultIdEncrypted: null,
        revokedAt: new Date(),
      },
    });
    const elapsed = await vaultUser("elapsed");
    const elapsedPayment = await fixture({
      status: PaymentStatus.CAPTURE_PENDING,
      updatedAt: STALE,
      unboundVault: { userId: elapsed.userId, createdAt: new Date(Date.now() - 4 * 3_600_000) },
    });
    const autonomyOff = await vaultUser("autonomy-off");
    const autonomyOffPayment = await fixture({
      status: PaymentStatus.CAPTURE_PENDING,
      updatedAt: STALE,
      unboundVault: { userId: autonomyOff.userId },
    });
    await database.user.update({
      where: { id: autonomyOff.userId },
      data: { globalAutonomousPurchasingEnabled: false },
    });
    // user.update bumps nothing on Payment, so the payment stays stale.
    const held = [revokedPayment, elapsedPayment, autonomyOffPayment];
    heldPaymentIds.push(...held.map((item) => item.payment.id));
    // Past the replay window the payment is not even scanned, so it cannot crowd the batch.

    const result = await vaultWorker([
      revoked.userId,
      elapsed.userId,
      autonomyOff.userId,
    ]).runOnce();
    expect(result.vaultReplays).toMatchObject({
      held: 2,
      completed: 0,
      failed: 0,
      returnedToPayer: 0,
      errors: 0,
    });
    expect(result).toMatchObject({ scanned: 2, pending: 2 });
    // Called directly, the service refuses to replay past the window too.
    const direct = await replayUnboundVaultOrder(
      {
        database,
        paypal: gateway,
        appUrl: "https://127.0.0.1",
        lookupDemoProduct: async () => null,
        vault,
      },
      { id: elapsed.userId },
      elapsedPayment.payment.id,
    );
    expect(direct).toMatchObject({
      heldReason: "REPLAY_WINDOW_ELAPSED",
      result: { outcome: "PENDING", reason: "REPLAY_WINDOW_ELAPSED" },
    });
    expect(createVaultOrder).not.toHaveBeenCalled();
    for (const item of held) {
      // Possibly already charged by the first request: never failed or released.
      expect(await holdState(item.payment.id, item.reservation.id)).toEqual({
        payment: PaymentStatus.CAPTURE_PENDING,
        reservation: ReservationStatus.ACTIVE,
      });
    }

    // Checkout switched off platform-wide: an otherwise eligible payment is held too.
    const controlsOff = await vaultUser("controls-off");
    const controlsOffPayment = await fixture({
      status: PaymentStatus.CAPTURE_PENDING,
      updatedAt: STALE,
      unboundVault: { userId: controlsOff.userId },
    });
    heldPaymentIds.push(controlsOffPayment.payment.id);
    const rows = [{ key: "payments.checkoutEnabled", valueJson: false }];
    const override = (client: object): object =>
      new Proxy(client, {
        get(target, property, receiver) {
          if (property === "platformSetting") return { findMany: async () => rows };
          if (property === "$transaction") {
            return (fn: (tx: unknown) => Promise<unknown>) =>
              (target as DatabaseClient).$transaction((tx) => fn(override(tx)));
          }
          return Reflect.get(target, property, receiver);
        },
      });
    const switchedOff = await vaultWorker(
      [controlsOff.userId],
      override(database) as DatabaseClient,
    ).runOnce();
    expect(switchedOff.vaultReplays).toMatchObject({ held: 1, completed: 0 });
    expect(createVaultOrder).not.toHaveBeenCalled();
    expect(
      await holdState(controlsOffPayment.payment.id, controlsOffPayment.reservation.id),
    ).toEqual({
      payment: PaymentStatus.CAPTURE_PENDING,
      reservation: ReservationStatus.ACTIVE,
    });

    // Once past the attention age, System health counts every held payment for operators.
    const later = new Date(Date.now() + 31 * 60_000);
    const allHeld = [...held, controlsOffPayment].map((item) => item.payment.id);
    expect(
      await database.payment.count({
        where: { ...unboundVaultPaymentWhere(later), id: { in: allHeld } },
      }),
    ).toBe(4);
  });
});
