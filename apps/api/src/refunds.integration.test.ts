import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPrismaClient,
  MandateRepository,
  PaymentStatus,
  ProductCondition,
  ProposalRepository,
  ReservationStatus,
} from "@mandatepay/database";
import { PayPalProviderError, type PayPalCapture, type PayPalRefund } from "@mandatepay/paypal";
import { evaluateProposal } from "./services/proposals.js";
import { registerRefundRoutes } from "./routes/refunds.js";
import type { RefundGateway } from "./services/refunds.js";

try {
  process.loadEnvFile?.(fileURLToPath(new URL("../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl)
  throw new Error("TEST_DATABASE_URL is required for refund integration tests.");
const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//u, ""));
if (!/_test$/u.test(databaseName) || process.env.DATABASE_URL === testDatabaseUrl) {
  throw new Error("Refund integration tests require an isolated *_test database.");
}

const database = createPrismaClient(testDatabaseUrl);
const app = Fastify({ logger: false });
const origin = process.env.APP_URL ?? "http://localhost:3000";
const runId = randomUUID().slice(0, 12);
const users = new Set<string>();
let userA = "";
let userB = "";

const getCapture = vi.fn<(captureId: string) => Promise<PayPalCapture>>();
const refundCapture = vi.fn<(input: unknown) => Promise<PayPalRefund>>();
const getRefund = vi.fn<(refundId: string) => Promise<PayPalRefund>>();
let providerRefundCounter = 0;
const paypal: RefundGateway = { getCapture, refundCapture, getRefund };

function headers(userId: string, requestOrigin = origin) {
  return { "x-test-user": userId, origin: requestOrigin, "content-type": "application/json" };
}

function requestKey(value: string) {
  return `refund-request-${runId}-${value}`;
}

function providerCapture(captureId: string, proposalId: string): PayPalCapture {
  return {
    id: captureId,
    status: "COMPLETED",
    amount: { currency_code: "USD", value: "100.00" },
    custom_id: proposalId,
    create_time: "2026-10-02T12:00:00Z",
  };
}

function providerRefund(
  refundId: string,
  amountMinor: number,
  invoiceId: string,
  status: PayPalRefund["status"] = "COMPLETED",
): PayPalRefund {
  return {
    id: refundId,
    status,
    amount: { currency_code: "USD", value: (amountMinor / 100).toFixed(2) },
    invoice_id: invoiceId,
    create_time: "2026-10-02T12:05:00Z",
  };
}

async function createRefundablePayment(key: string) {
  const now = Date.now();
  const mandate = await new MandateRepository(database).create({
    userId: userA,
    title: "Refund mandate " + key,
    originalPrompt: "Buy demo goods and permit explicit refunds.",
    autoSpendLimit: 20_000n,
    transactionLimit: 20_000n,
    dailyLimit: 100_000n,
    weeklyLimit: 100_000n,
    monthlyLimit: 100_000n,
    startsAt: new Date(now - 60_000),
    expiresAt: new Date(now + 86_400_000),
    status: "ACTIVE",
    canonicalRules: {
      title: "Refund mandate " + key,
      productIntent: "demo goods",
      currency: "USD",
      timezone: "UTC",
      allowedBrands: [],
      blockedBrands: [],
      allowedCategories: [],
      blockedCategories: [],
      allowedConditions: ["NEW"],
      autoSpendLimit: 20_000,
      transactionLimit: 20_000,
      dailyLimit: 100_000,
      weeklyLimit: 100_000,
      monthlyLimit: 100_000,
      quantityLimit: 1,
      allowedMerchants: [],
      blockedMerchants: [],
      newMerchantRequiresApproval: false,
      startsAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 86_400_000).toISOString(),
    },
  });
  const product = await database.productSnapshot.create({
    data: {
      source: "refund-test",
      externalId: `refund-product-${runId}-${key}`,
      title: "Refund test product",
      brand: "Demo Brand",
      category: "demo",
      condition: ProductCondition.NEW,
      price: 10_000n,
      currency: "USD",
      merchant: "Refund Test Merchant",
      metadata: { test: true },
    },
  });
  const proposal = await new ProposalRepository(database).create({
    userId: userA,
    mandateId: mandate.id,
    mandateVersionId: mandate.activeVersionId ?? "",
    productSnapshotId: product.id,
    quantity: 1,
    shipping: 0n,
    tax: 0n,
    idempotencyKey: `refund-proposal-${runId}-${key}`,
  });
  await evaluateProposal(database, { id: userA }, proposal.id);
  const captureId = `CAPTURE-${runId}-${key}`;
  const payment = await database.$transaction(async (tx) => {
    const created = await tx.payment.create({
      data: {
        userId: userA,
        mandateId: mandate.id,
        proposalId: proposal.id,
        paypalCaptureId: captureId,
        amount: 10_000n,
        currency: "USD",
        status: PaymentStatus.COMPLETED,
        idempotencyKey: `refund-payment-${runId}-${key}`,
        capturedAt: new Date("2026-10-02T12:00:00Z"),
      },
    });
    await tx.purchaseProposal.update({ where: { id: proposal.id }, data: { status: "COMPLETED" } });
    const reservation = await tx.spendReservation.findUnique({
      where: { proposalId: proposal.id },
    });
    if (reservation) {
      await tx.spendReservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.CONSUMED, consumedAt: new Date("2026-10-02T12:00:00Z") },
      });
    }
    return created;
  });
  getCapture.mockImplementation(async () => providerCapture(captureId, proposal.id));
  return { payment, proposal, mandate, captureId };
}

describe("PayPal refund boundary", () => {
  beforeAll(async () => {
    const first = await database.user.create({
      data: {
        email: `refund-a-${runId}@mandatepay.local`,
        name: "Refund A",
        globalAutonomousPurchasingEnabled: true,
      },
    });
    const second = await database.user.create({
      data: {
        email: `refund-b-${runId}@mandatepay.local`,
        name: "Refund B",
        globalAutonomousPurchasingEnabled: true,
      },
    });
    userA = first.id;
    userB = second.id;
    users.add(userA);
    users.add(userB);
    registerRefundRoutes(app, {
      database,
      paypal,
      requireUser: async (request, reply) => {
        const id = request.headers["x-test-user"];
        if (typeof id !== "string" || !users.has(id)) {
          await reply.status(401).send({ error: "Unauthorized" });
          return null;
        }
        return { id };
      },
      isTrustedOrigin: (requestOrigin) => requestOrigin === origin,
    });
    await app.ready();
    refundCapture.mockImplementation(async (input) => {
      const value = input as { amountMinor: number; invoiceId: string };
      providerRefundCounter += 1;
      return providerRefund(
        `REFUND-${runId}-${providerRefundCounter}`,
        value.amountMinor,
        value.invoiceId,
      );
    });
    getRefund.mockImplementation(async (refundId) => providerRefund(refundId, 2_500, refundId));
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it("requires confirmation, trusted origin, and payment ownership", async () => {
    const { payment } = await createRefundablePayment("guards");
    const missingConfirmation = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/refund`,
      headers: headers(userA),
      payload: { amountMinor: 1_000, reason: "Damaged", requestKey: requestKey("guards-a") },
    });
    expect(missingConfirmation.statusCode).toBe(400);
    const untrusted = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/refund`,
      headers: headers(userA, "https://attacker.example"),
      payload: {
        amountMinor: 1_000,
        reason: "Damaged",
        requestKey: requestKey("guards-b"),
        confirmed: true,
      },
    });
    expect(untrusted.statusCode).toBe(403);
    const otherUser = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/refund`,
      headers: headers(userB),
      payload: {
        amountMinor: 1_000,
        reason: "Damaged",
        requestKey: requestKey("guards-c"),
        confirmed: true,
      },
    });
    expect(otherUser.statusCode).toBe(404);
  });

  it("processes partial then server-computed full remaining refund", async () => {
    const { payment } = await createRefundablePayment("partial-full");
    const partial = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/refund`,
      headers: headers(userA),
      payload: {
        amountMinor: 2_500,
        reason: "Damaged item",
        requestKey: requestKey("partial-1"),
        confirmed: true,
      },
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.json().refund.amount).toBe(2_500);
    expect(partial.json().payment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    const full = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/refund`,
      headers: headers(userA),
      payload: {
        amountMinor: null,
        reason: "Return remaining",
        requestKey: requestKey("partial-2"),
        confirmed: true,
      },
    });
    expect(full.statusCode).toBe(200);
    expect(full.json().refund.amount).toBe(7_500);
    expect(full.json().payment.status).toBe(PaymentStatus.REFUNDED);
    expect(refundCapture.mock.calls.at(-2)?.[0]).toMatchObject({ amountMinor: 2_500 });
    expect(refundCapture.mock.calls.at(-1)?.[0]).toMatchObject({ amountMinor: 7_500 });
  });

  it("serializes concurrent refunds against the same captured payment", async () => {
    const { payment } = await createRefundablePayment("concurrent");
    const responses = await Promise.all(
      ["concurrent-a", "concurrent-b"].map((key) =>
        app.inject({
          method: "POST",
          url: `/api/payments/${payment.id}/refund`,
          headers: headers(userA),
          payload: {
            amountMinor: 6_000,
            reason: "Concurrent request",
            requestKey: requestKey(key),
            confirmed: true,
          },
        }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(1);
  });

  it("replays a request key before recomputing full remaining amount and rejects changed payloads", async () => {
    const { payment } = await createRefundablePayment("replay");
    const replayRequestKey = requestKey("replay-key");
    const first = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/refund`,
      headers: headers(userA),
      payload: {
        amountMinor: null,
        reason: "Full return",
        requestKey: replayRequestKey,
        confirmed: true,
      },
    });
    expect(first.statusCode).toBe(200);
    const calls = refundCapture.mock.calls.length;
    const replay = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/refund`,
      headers: headers(userA),
      payload: {
        amountMinor: null,
        reason: "Full return",
        requestKey: replayRequestKey,
        confirmed: true,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(refundCapture.mock.calls.length).toBe(calls);
    const changed = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/refund`,
      headers: headers(userA),
      payload: {
        amountMinor: 1_000,
        reason: "Changed",
        requestKey: replayRequestKey,
        confirmed: true,
      },
    });
    expect(changed.statusCode).toBe(409);
  });

  it("holds unknown provider outcomes in SUBMITTED and recovers with the same request ID", async () => {
    const { payment } = await createRefundablePayment("unknown");
    const unknownRequestKey = requestKey("unknown-key");
    refundCapture.mockRejectedValueOnce(
      new PayPalProviderError("UPSTREAM_TIMEOUT", undefined, {
        retryable: true,
        unknownOutcome: true,
      }),
    );
    const pending = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/refund`,
      headers: headers(userA),
      payload: {
        amountMinor: 2_500,
        reason: "Unknown provider result",
        requestKey: unknownRequestKey,
        confirmed: true,
      },
    });
    expect(pending.statusCode).toBe(202);
    expect(pending.json().pending).toBe(true);
    expect(pending.json().refund.status).toBe("SUBMITTED");
    const retried = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/refund`,
      headers: headers(userA),
      payload: {
        amountMinor: 2_500,
        reason: "Unknown provider result",
        requestKey: unknownRequestKey,
        confirmed: true,
      },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().refund.status).toBe("COMPLETED");
    const requests = refundCapture.mock.calls
      .map((call) => (call[0] as { requestId?: string }).requestId)
      .filter((value): value is string => Boolean(value));
    expect(requests.at(-1)).toBe(requests.at(-2));
  });

  it("allows a refund after the mandate is revoked while rejecting provider mismatches", async () => {
    const { payment, mandate } = await createRefundablePayment("revoked");
    await database.mandate.update({ where: { id: mandate.id }, data: { status: "REVOKED" } });
    refundCapture.mockResolvedValueOnce({
      ...providerRefund("REFUND-MISMATCH", 2_500, "wrong-invoice"),
      amount: { currency_code: "USD", value: "9.00" },
    });
    const mismatch = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/refund`,
      headers: headers(userA),
      payload: {
        amountMinor: 2_500,
        reason: "Mismatch",
        requestKey: requestKey("revoked-mismatch"),
        confirmed: true,
      },
    });
    expect(mismatch.statusCode).toBe(503);
    expect(
      (
        await database.refund.findFirst({
          where: { userId: userA, idempotencyKey: requestKey("revoked-mismatch") },
        })
      )?.status,
    ).toBe("SUBMITTED");
  });
});
