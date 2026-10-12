import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createPrismaClient,
  MandateRepository,
  ProposalRepository,
  PaymentStatus,
  ReservationStatus,
  ProductCondition,
} from "@mandatepay/database";
import { registerPayPalRoutes } from "./routes/paypal.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import {
  approveProposal,
  evaluateProposal,
  revalidateAuthorizationInTransaction,
} from "./services/proposals.js";
import type { DemoProductFacts, PayPalGateway } from "./services/payments.js";
import { PayPalProviderError, type PayPalCapture, type PayPalOrder } from "@mandatepay/paypal";
import { lookupDemoProduct as lookupCatalogProduct } from "@mandatepay/channel3";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl)
  throw new Error("TEST_DATABASE_URL is required for payment integration tests.");
const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//u, ""));
if (!/_test$/u.test(databaseName) || process.env.DATABASE_URL === testDatabaseUrl) {
  throw new Error("Payment integration tests require an isolated *_test database.");
}

const database = createPrismaClient(testDatabaseUrl);
const app = Fastify({ logger: false });
const origin = process.env.APP_URL ?? "http://localhost:3000";
const users = new Set<string>();
const products = new Map<string, DemoProductFacts>();
const testRunId = randomUUID().slice(0, 12);
let userA = "";
let userB = "";
let mandateA = "";
let versionA = "";
let proposalId = "";

const createOrder =
  vi.fn<(input: Parameters<PayPalGateway["createOrder"]>[0]) => Promise<PayPalOrder>>();
const getOrder = vi.fn<(orderId: string) => Promise<PayPalOrder>>();
const captureOrder = vi.fn<(orderId: string, requestId: string) => Promise<PayPalCapture>>();
const paypal: PayPalGateway = { createOrder, getOrder, captureOrder };

function money(minor: number) {
  return { currency_code: "USD" as const, value: (minor / 100).toFixed(2) };
}

function providerOrder(input: {
  id: string;
  status: PayPalOrder["status"];
  amount: number;
  referenceId: string;
  customId: string;
}): PayPalOrder {
  return {
    id: input.id,
    status: input.status,
    links: [
      {
        href: "https://sandbox.paypal.com/checkoutnow?token=" + input.id,
        rel: "approve",
        method: "GET",
      },
    ],
    purchase_units: [
      {
        reference_id: input.referenceId,
        custom_id: input.customId,
        amount: money(input.amount),
      },
    ],
    approvalUrl: "https://sandbox.paypal.com/checkoutnow?token=" + input.id,
  };
}

function providerCapture(input: { id: string; amount: number; customId: string }): PayPalCapture {
  return {
    id: input.id,
    status: "COMPLETED",
    amount: money(input.amount),
    custom_id: input.customId,
    create_time: "2026-10-02T12:00:00Z",
  };
}

function headers(userId: string) {
  return { "x-test-user": userId, origin, "content-type": "application/json" };
}

async function createProposal(price: bigint, key: string) {
  const uniqueKey = `${testRunId}-${key}`;
  const snapshot = await database.productSnapshot.create({
    data: {
      source: "demo",
      externalId: "payment-product-" + uniqueKey,
      title: "Demo headphones " + uniqueKey,
      brand: "Sony",
      category: "headphones",
      condition: ProductCondition.NEW,
      price,
      currency: "USD",
      merchant: "MandatePay Demo Merchant",
      metadata: { externalId: "payment-product-" + uniqueKey, demoSku: "sku-" + uniqueKey },
    },
  });
  products.set(snapshot.externalId, {
    externalId: snapshot.externalId,
    priceMinor: Number(price),
    currency: "USD",
    brand: "Sony",
    condition: "NEW",
    merchant: "MandatePay Demo Merchant",
    checkoutEligible: true,
    demoSku: "sku-" + uniqueKey,
  });
  const proposal = await new ProposalRepository(database).create({
    userId: userA,
    mandateId: mandateA,
    mandateVersionId: versionA,
    productSnapshotId: snapshot.id,
    quantity: 1,
    shipping: 0n,
    tax: 0n,
    idempotencyKey: "payment-proposal-" + uniqueKey,
  });
  await evaluateProposal(database, { id: userA }, proposal.id);
  proposalId = proposal.id;
  return { proposal, snapshot };
}

describe("PayPal payment boundary", () => {
  beforeAll(async () => {
    const first = await database.user.create({
      data: {
        email: `payment-a-${testRunId}@mandatepay.local`,
        name: "Payment A",
        globalAutonomousPurchasingEnabled: true,
      },
    });
    const second = await database.user.create({
      data: {
        email: `payment-b-${testRunId}@mandatepay.local`,
        name: "Payment B",
        globalAutonomousPurchasingEnabled: true,
      },
    });
    userA = first.id;
    userB = second.id;
    users.add(userA);
    users.add(userB);
    const now = Date.now();
    const mandate = await new MandateRepository(database).create({
      userId: userA,
      title: "Payment mandate",
      originalPrompt: "Buy new Sony headphones under the approved limit.",
      autoSpendLimit: 20_000n,
      transactionLimit: 30_000n,
      dailyLimit: 1_000_000n,
      weeklyLimit: 1_000_000n,
      monthlyLimit: 1_000_000n,
      startsAt: new Date(now - 60_000),
      expiresAt: new Date(now + 86_400_000),
      status: "ACTIVE",
      canonicalRules: {
        title: "Payment mandate",
        productIntent: "new Sony headphones",
        currency: "USD",
        timezone: "UTC",
        allowedBrands: ["Sony"],
        blockedBrands: [],
        allowedCategories: ["headphones"],
        blockedCategories: [],
        allowedConditions: ["NEW"],
        autoSpendLimit: 20_000,
        transactionLimit: 30_000,
        dailyLimit: 1_000_000,
        weeklyLimit: 1_000_000,
        monthlyLimit: 1_000_000,
        quantityLimit: 1,
        allowedMerchants: [],
        blockedMerchants: [],
        newMerchantRequiresApproval: false,
        startsAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 86_400_000).toISOString(),
      },
    });
    mandateA = mandate.id;
    versionA = mandate.activeVersionId ?? "";

    registerPayPalRoutes(app, {
      database,
      appUrl: origin,
      paypal,
      lookupDemoProduct: async (externalId) => {
        const fixture = products.get(externalId);
        if (fixture) return fixture;
        const product = lookupCatalogProduct(externalId);
        if (!product) return null;
        return {
          externalId: product.externalId,
          priceMinor: product.priceMinor,
          currency: product.currency,
          brand: product.brand,
          condition: product.condition,
          merchant: product.merchant,
          checkoutEligible: product.checkoutEligible,
          demoSku: product.demoSku,
        };
      },
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
    registerCatalogRoutes(app, {
      database,
      mode: "demo",
      rank: async () => [],
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

    createOrder.mockImplementation(async (input) =>
      providerOrder({
        id: "ORDER-" + input.referenceId,
        status: "CREATED",
        amount: Number(input.amountMinor),
        referenceId: input.referenceId,
        customId: input.customId,
      }),
    );
    getOrder.mockImplementation(async (orderId) =>
      providerOrder({
        id: orderId,
        status: "APPROVED",
        amount: 13_900,
        referenceId: orderId.startsWith("ORDER-") ? orderId.slice(6) : orderId,
        customId: proposalId,
      }),
    );
    captureOrder.mockImplementation(async () =>
      providerCapture({ id: "CAPTURE-" + Date.now(), amount: 13_900, customId: proposalId }),
    );
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it("claims an order from server-owned totals and reuses the same provider request", async () => {
    const { proposal } = await createProposal(13_900n, "allow");
    const response = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id, amount: 1, currency: "EUR" },
    });
    expect(response.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().payment.amount).toBe(13_900);
    expect(created.json().approvalUrl).toContain("sandbox.paypal.com");
    expect(created.json().pending).toBe(false);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder.mock.calls[0]?.[0].amountMinor).toBe(13_900);
    expect(createOrder.mock.calls[0]?.[0].requestId).toHaveLength(36);
    expect(createOrder.mock.calls[0]?.[0].returnUrl).toContain("/orders/");

    const retry = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().payment.id).toBe(created.json().payment.id);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("accepts a real demo catalog proposal whose snapshot identity is content-addressed", async () => {
    const requestKey = `catalog-${testRunId}`;
    const proposalResponse = await app.inject({
      method: "POST",
      url: "/api/proposals",
      headers: headers(userA),
      payload: {
        mandateId: mandateA,
        source: "demo",
        productId: "demo-headphones-139",
        quantity: 1,
        requestKey,
      },
    });
    expect(proposalResponse.statusCode).toBe(201);
    const catalogProposalId = proposalResponse.json().proposal.id as string;
    const catalogProposal = await database.purchaseProposal.findUnique({
      where: { id: catalogProposalId },
      include: { productSnapshot: true },
    });
    expect(catalogProposal?.productSnapshot.externalId).not.toBe("demo-headphones-139");
    expect(catalogProposal?.productSnapshot.metadata).toMatchObject({
      externalId: "demo-headphones-139",
      demoSku: "demo-sku-headphones-139",
    });
    await evaluateProposal(database, { id: userA }, catalogProposalId);
    proposalId = catalogProposalId;
    const order = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: catalogProposalId },
    });
    expect(order.statusCode).toBe(200);
    expect(order.json().payment.product.source).toBe("demo");
  });

  it("serializes concurrent order claims around one stable PayPal request id", async () => {
    const { proposal } = await createProposal(13_900n, "concurrent-order");
    const before = createOrder.mock.calls.length;
    const responses = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: "POST",
          url: "/api/paypal/orders",
          headers: headers(userA),
          payload: { proposalId: proposal.id },
        }),
      ),
    );
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[0]?.json().payment.id).toBe(responses[1]?.json().payment.id);
    expect(createOrder.mock.calls.length).toBe(before + 1);
    expect(createOrder.mock.calls[0]?.[0].requestId).toBe(
      createOrder.mock.calls.at(-1)?.[0].requestId,
    );
  });

  it("hydrates a minimal create response before binding the local payment", async () => {
    const { proposal } = await createProposal(13_900n, "minimal-create");
    let referenceId = "";
    const fullOrderId = "ORDER-MINIMAL-" + testRunId;
    createOrder.mockImplementationOnce(async (input) => {
      referenceId = input.referenceId;
      return {
        ...providerOrder({
          id: fullOrderId,
          status: "CREATED",
          amount: 13_900,
          referenceId,
          customId: proposal.id,
        }),
        purchase_units: undefined,
      };
    });
    getOrder.mockImplementationOnce(async () =>
      providerOrder({
        id: fullOrderId,
        status: "CREATED",
        amount: 13_900,
        referenceId,
        customId: proposal.id,
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().payment.paypalOrderId).toBe(fullOrderId);
    expect(getOrder).toHaveBeenCalledWith(fullOrderId);
  });

  it("keeps ownership and never lets a second user claim the proposal", async () => {
    const { proposal } = await createProposal(13_900n, "owner");
    const response = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userB),
      payload: { proposalId: proposal.id },
    });
    expect(response.statusCode).toBe(404);
  });

  it("requires a fresh approval after autonomous purchasing is disabled", async () => {
    const { proposal } = await createProposal(13_900n, "kill-switch");
    await database.user.update({
      where: { id: userA },
      data: { globalAutonomousPurchasingEnabled: false },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    expect(response.statusCode).toBe(409);
    expect(createOrder).not.toHaveBeenCalledWith(
      expect.objectContaining({ customId: proposal.id }),
    );
    await database.user.update({
      where: { id: userA },
      data: { globalAutonomousPurchasingEnabled: true },
    });
  });

  it("captures only an approved PayPal order and makes duplicate capture idempotent", async () => {
    const { proposal } = await createProposal(13_900n, "capture");
    const created = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    const paymentId = created.json().payment.id as string;
    const captured = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${paymentId}/capture`,
      headers: headers(userA),
      payload: {},
    });
    expect(captured.statusCode).toBe(200);
    expect(captured.json().payment.status).toBe(PaymentStatus.COMPLETED);
    expect(captured.json().payment.amount).toBe(13_900);
    const reservation = await database.spendReservation.findUnique({
      where: { proposalId: proposal.id },
    });
    expect(reservation?.status).toBe(ReservationStatus.CONSUMED);
    const calls = captureOrder.mock.calls.length;
    const retry = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${paymentId}/capture`,
      headers: headers(userA),
      payload: {},
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().payment.status).toBe(PaymentStatus.COMPLETED);
    expect(captureOrder).toHaveBeenCalledTimes(calls);
  });

  it("turns an existing unpaid order into a reviewable approval after the kill switch changes", async () => {
    const { proposal } = await createProposal(13_900n, "refresh-approval");
    const created = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    const paymentId = created.json().payment.id as string;
    await database.user.update({
      where: { id: userA },
      data: { globalAutonomousPurchasingEnabled: false },
    });
    const captureCalls = captureOrder.mock.calls.length;
    const held = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${paymentId}/capture`,
      headers: headers(userA),
      payload: {},
    });
    expect(held.statusCode).toBe(409);
    expect(captureOrder).toHaveBeenCalledTimes(captureCalls);
    expect(
      (await database.purchaseProposal.findUnique({ where: { id: proposal.id } }))?.status,
    ).toBe("AWAITING_APPROVAL");
    await approveProposal(database, { id: userA }, proposal.id);
    const captured = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${paymentId}/capture`,
      headers: headers(userA),
      payload: {},
    });
    expect(captured.statusCode).toBe(200);
    expect(captured.json().payment.status).toBe(PaymentStatus.COMPLETED);
    await database.user.update({
      where: { id: userA },
      data: { globalAutonomousPurchasingEnabled: true },
    });
  });

  it("holds the reservation when PayPal capture data is mismatched, then retries safely", async () => {
    const { proposal } = await createProposal(13_900n, "mismatch");
    const created = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    const paymentId = created.json().payment.id as string;
    const original = captureOrder.getMockImplementation();
    captureOrder.mockResolvedValueOnce(
      providerCapture({ id: "CAPTURE-MISMATCH", amount: 14_000, customId: proposal.id }),
    );
    const mismatch = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${paymentId}/capture`,
      headers: headers(userA),
      payload: {},
    });
    expect(mismatch.statusCode).toBe(202);
    expect(mismatch.json().payment.status).toBe(PaymentStatus.CAPTURE_PENDING);
    expect(
      (await database.spendReservation.findUnique({ where: { proposalId: proposal.id } }))?.status,
    ).toBe(ReservationStatus.ACTIVE);
    if (original) captureOrder.mockImplementation(original);
    const retried = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${paymentId}/capture`,
      headers: headers(userA),
      payload: {},
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().payment.status).toBe(PaymentStatus.COMPLETED);
  });

  it("reconciles a lost capture response from a verified completed PayPal order", async () => {
    const { proposal } = await createProposal(13_900n, "lost-response");
    const created = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    const paymentId = created.json().payment.id as string;
    captureOrder.mockRejectedValueOnce(
      new PayPalProviderError("UPSTREAM_TIMEOUT", undefined, {
        retryable: true,
        unknownOutcome: true,
      }),
    );
    const pending = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${paymentId}/capture`,
      headers: headers(userA),
      payload: {},
    });
    expect(pending.statusCode).toBe(202);
    const beforeReconcile = captureOrder.mock.calls.length;
    const capture = providerCapture({
      id: `CAPTURE-LOST-${testRunId}`,
      amount: 13_900,
      customId: proposal.id,
    });
    const completedOrder = {
      ...providerOrder({
        id: created.json().payment.paypalOrderId,
        status: "COMPLETED",
        amount: 13_900,
        referenceId: paymentId,
        customId: proposal.id,
      }),
      purchase_units: [
        {
          reference_id: paymentId,
          custom_id: proposal.id,
          amount: money(13_900),
          payments: { captures: [capture] },
        },
      ],
    } satisfies PayPalOrder;
    getOrder.mockResolvedValueOnce(completedOrder);
    const reconciled = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${paymentId}/capture`,
      headers: headers(userA),
      payload: {},
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json().payment.status).toBe(PaymentStatus.COMPLETED);
    expect(reconciled.json().payment.capturedAt).toBe("2026-10-02T12:00:00.000Z");
    expect(captureOrder.mock.calls.length).toBe(beforeReconcile);
  });

  it("records a validated declined capture and releases its reservation", async () => {
    const { proposal } = await createProposal(13_900n, "declined");
    const created = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    const paymentId = created.json().payment.id as string;
    captureOrder.mockResolvedValueOnce({
      ...providerCapture({
        id: `CAPTURE-DENIED-${testRunId}`,
        amount: 13_900,
        customId: proposal.id,
      }),
      status: "DECLINED",
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${paymentId}/capture`,
      headers: headers(userA),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().payment.status).toBe(PaymentStatus.DENIED);
    expect(
      (await database.spendReservation.findUnique({ where: { proposalId: proposal.id } }))?.status,
    ).toBe(ReservationStatus.RELEASED);
  });

  it("retains an active reservation after an unknown order outcome and reuses its request key", async () => {
    const { proposal } = await createProposal(13_900n, "unknown");
    const first = createOrder.mock.results.length;
    createOrder.mockRejectedValueOnce(
      new PayPalProviderError("UPSTREAM_TIMEOUT", undefined, {
        retryable: true,
        unknownOutcome: true,
      }),
    );
    const pending = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    expect(pending.statusCode).toBe(202);
    expect(pending.json().pending).toBe(true);
    expect(pending.json().payment.paypalOrderId).toBeNull();
    expect(
      (await database.spendReservation.findUnique({ where: { proposalId: proposal.id } }))?.status,
    ).toBe(ReservationStatus.ACTIVE);
    const retry = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    expect(retry.statusCode).toBe(200);
    expect(createOrder.mock.results.length).toBe(first + 2);
    expect(createOrder.mock.calls.at(-1)?.[0].requestId).toBe(
      createOrder.mock.calls.at(-2)?.[0].requestId,
    );
  });

  it("settles a lost capture with an offset timestamp through read-only recovery after expiry and catalogue removal", async () => {
    const { proposal, snapshot } = await createProposal(13900n, "review-read-recovery");
    const created = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    const payment = created.json().payment;
    captureOrder.mockRejectedValueOnce(
      new PayPalProviderError("UPSTREAM_TIMEOUT", undefined, { unknownOutcome: true }),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/paypal/orders/${payment.id}/capture`,
          headers: headers(userA),
          payload: {},
        })
      ).statusCode,
    ).toBe(202);
    const mutations = captureOrder.mock.calls.length;
    await database.purchaseProposal.update({
      where: { id: proposal.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    products.delete(snapshot.externalId);
    const capture = {
      ...providerCapture({
        id: `CAPTURE-RECOVER-${testRunId}`,
        amount: 13900,
        customId: proposal.id,
      }),
      create_time: "2026-10-03T23:00:06-07:00",
    };
    getOrder.mockResolvedValueOnce({
      ...providerOrder({
        id: payment.paypalOrderId,
        status: "COMPLETED",
        amount: 13900,
        referenceId: payment.id,
        customId: proposal.id,
      }),
      purchase_units: [
        {
          reference_id: payment.id,
          custom_id: proposal.id,
          amount: money(13900),
          payments: { captures: [capture] },
        },
      ],
    });
    const result = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${payment.id}/reconcile`,
      headers: headers(userA),
      payload: {},
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().payment.status).toBe("COMPLETED");
    expect(result.json().payment.capturedAt).toBe("2026-10-04T06:00:06.000Z");
    expect(captureOrder.mock.calls.length).toBe(mutations);
    expect(
      (await database.spendReservation.findUniqueOrThrow({ where: { proposalId: proposal.id } }))
        .status,
    ).toBe("CONSUMED");
  });

  it("keeps payment recovery owned, origin-checked and free of captures for approved orders", async () => {
    const { proposal } = await createProposal(13900n, "review-approved-status");
    const payment = (
      await app.inject({
        method: "POST",
        url: "/api/paypal/orders",
        headers: headers(userA),
        payload: { proposalId: proposal.id },
      })
    ).json().payment;
    const mutations = captureOrder.mock.calls.length;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/paypal/orders/${payment.id}/reconcile`,
          headers: headers(userB),
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/paypal/orders/${payment.id}/reconcile`,
          headers: { ...headers(userA), origin: "https://attacker.example" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    const result = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${payment.id}/reconcile`,
      headers: headers(userA),
      payload: {},
    });
    expect(result.json().payment.status).toBe("APPROVED");
    expect(result.json().payment.authorizationExpiresAt).toBeTruthy();
    expect(captureOrder.mock.calls.length).toBe(mutations);
  });

  it("does not expose or execute seeded sample payments", async () => {
    const { proposal } = await createProposal(13900n, "review-sample");
    const payment = (
      await app.inject({
        method: "POST",
        url: "/api/paypal/orders",
        headers: headers(userA),
        payload: { proposalId: proposal.id },
      })
    ).json().payment;
    await database.payment.update({ where: { id: payment.id }, data: { isSample: true } });
    const mutations = captureOrder.mock.calls.length;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/orders/${payment.id}`,
          headers: headers(userA),
        })
      ).statusCode,
    ).toBe(404);
    for (const action of ["capture", "reconcile"])
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/paypal/orders/${payment.id}/${action}`,
            headers: headers(userA),
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/paypal/orders",
          headers: headers(userA),
          payload: { proposalId: proposal.id },
        })
      ).statusCode,
    ).toBe(404);
    const list = await app.inject({ method: "GET", url: "/api/orders", headers: headers(userA) });
    expect(list.json().orders.some((row: { id: string }) => row.id === payment.id)).toBe(false);
    expect(captureOrder.mock.calls.length).toBe(mutations);
  });

  it("preserves refunded receipts when order/capture requests are repeated", async () => {
    const { proposal, snapshot } = await createProposal(13900n, "review-refunded-replay");
    const payment = (
      await app.inject({
        method: "POST",
        url: "/api/paypal/orders",
        headers: headers(userA),
        payload: { proposalId: proposal.id },
      })
    ).json().payment;
    await database.payment.update({
      where: { id: payment.id },
      data: { status: "REFUNDED", paypalCaptureId: `CAPTURE-REFUNDED-${testRunId}` },
    });
    products.delete(snapshot.externalId);
    const mutations = captureOrder.mock.calls.length;
    const result = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${payment.id}/capture`,
      headers: headers(userA),
      payload: {},
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().payment.status).toBe("REFUNDED");
    const order = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    expect(order.statusCode).toBe(200);
    expect(order.json().payment.status).toBe("REFUNDED");
    expect(captureOrder.mock.calls.length).toBe(mutations);
  });
  async function orderFor(key: string) {
    const { proposal, snapshot } = await createProposal(13_900n, key);
    const created = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    expect(created.statusCode).toBe(200);
    const payment = created.json().payment as { id: string; paypalOrderId: string };
    return { proposal, snapshot, payment };
  }

  function rejection(issue: string, status = 422) {
    return new PayPalProviderError("UPSTREAM_REQUEST_FAILED", status, {
      details: { name: "UNPROCESSABLE_ENTITY", issue, debugId: "debug" + issue.slice(0, 8) },
    });
  }

  async function capture(paymentId: string) {
    return app.inject({
      method: "POST",
      url: `/api/paypal/orders/${paymentId}/capture`,
      headers: headers(userA),
      payload: {},
    });
  }

  it("fails a definitively declined capture and releases its reservation in one step", async () => {
    const { proposal, payment } = await orderFor("definitive-decline");
    captureOrder.mockRejectedValueOnce(rejection("TRANSACTION_REFUSED"));
    const response = await capture(payment.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().payment.status).toBe(PaymentStatus.FAILED);
    expect(response.json().payment.failureCode).toBe("PAYPAL_CAPTURE_REJECTED:TRANSACTION_REFUSED");
    expect(
      (await database.purchaseProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status,
    ).toBe("FAILED");
    expect(
      (await database.spendReservation.findUniqueOrThrow({ where: { proposalId: proposal.id } }))
        .status,
    ).toBe(ReservationStatus.RELEASED);
    const audits = await database.auditEvent.findMany({
      where: { entityId: payment.id, eventType: "PAYMENT_FAILED" },
    });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]?.payload)).toContain("TRANSACTION_REFUSED");
    // A retry is a no-op on the terminal receipt; nothing is replayed.
    const calls = captureOrder.mock.calls.length;
    expect((await capture(payment.id)).json().payment.status).toBe(PaymentStatus.FAILED);
    expect(captureOrder.mock.calls.length).toBe(calls);
  });

  it("returns an INSTRUMENT_DECLINED capture to the payer with a new request id, then captures", async () => {
    const { proposal, payment } = await orderFor("instrument-declined");
    captureOrder.mockRejectedValueOnce(rejection("INSTRUMENT_DECLINED"));
    const before = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const declined = await capture(payment.id);
    expect(declined.statusCode).toBe(200);
    expect(declined.json().payment).toMatchObject({
      status: PaymentStatus.APPROVED,
      providerStatusReason: "INSTRUMENT_DECLINED",
    });
    expect(declined.json().payment.payerActionUrl).toContain("sandbox.paypal.com");
    const after = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.paypalCaptureRequestId).not.toBe(before.paypalCaptureRequestId);
    expect(
      (await database.purchaseProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status,
    ).toBe("PAYPAL_ORDER_CREATED");
    expect(
      (await database.spendReservation.findUniqueOrThrow({ where: { proposalId: proposal.id } }))
        .status,
    ).toBe(ReservationStatus.ACTIVE);

    // The payer chose another funding source; the next capture uses the new key.
    const completed = await capture(payment.id);
    expect(completed.statusCode).toBe(200);
    expect(completed.json().payment.status).toBe(PaymentStatus.COMPLETED);
    expect(completed.json().payment.payerActionUrl).toBeNull();
    expect(captureOrder.mock.calls.at(-1)?.[1]).toBe(after.paypalCaptureRequestId);
  });

  it("returns ORDER_NOT_APPROVED to awaiting approval", async () => {
    const { payment } = await orderFor("not-approved");
    captureOrder.mockRejectedValueOnce(rejection("ORDER_NOT_APPROVED"));
    const response = await capture(payment.id);
    expect(response.json().payment).toMatchObject({
      status: PaymentStatus.CREATED,
      providerStatusReason: "ORDER_NOT_APPROVED",
    });
    expect(response.json().payment.payerActionUrl).toContain("checkoutnow");
  });

  it("finalizes ORDER_ALREADY_CAPTURED from the authoritative order without capturing again", async () => {
    const { proposal, payment } = await orderFor("already-captured");
    captureOrder.mockRejectedValueOnce(rejection("ORDER_ALREADY_CAPTURED"));
    const existing = providerCapture({
      id: `CAPTURE-ALREADY-${testRunId}`,
      amount: 13_900,
      customId: proposal.id,
    });
    getOrder.mockResolvedValueOnce(
      providerOrder({
        id: payment.paypalOrderId,
        status: "APPROVED",
        amount: 13_900,
        referenceId: payment.id,
        customId: proposal.id,
      }),
    );
    getOrder.mockResolvedValueOnce({
      ...providerOrder({
        id: payment.paypalOrderId,
        status: "COMPLETED",
        amount: 13_900,
        referenceId: payment.id,
        customId: proposal.id,
      }),
      purchase_units: [
        {
          reference_id: payment.id,
          custom_id: proposal.id,
          amount: money(13_900),
          payments: { captures: [existing] },
        },
      ],
    });
    const calls = captureOrder.mock.calls.length;
    const response = await capture(payment.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().payment.status).toBe(PaymentStatus.COMPLETED);
    expect(response.json().payment.paypalCaptureId).toBe(existing.id);
    expect(captureOrder.mock.calls.length).toBe(calls + 1);
    expect(
      (await database.spendReservation.findUniqueOrThrow({ where: { proposalId: proposal.id } }))
        .status,
    ).toBe(ReservationStatus.CONSUMED);
  });

  it("keeps a held PENDING capture with its reason and the reservation", async () => {
    const { proposal, payment } = await orderFor("held-capture");
    captureOrder.mockResolvedValueOnce({
      ...providerCapture({
        id: `CAPTURE-HELD-${testRunId}`,
        amount: 13_900,
        customId: proposal.id,
      }),
      status: "PENDING",
      status_details: { reason: "PENDING_REVIEW" },
    });
    const response = await capture(payment.id);
    expect(response.statusCode).toBe(202);
    expect(response.json().payment).toMatchObject({
      status: PaymentStatus.CAPTURE_PENDING,
      providerStatusReason: "PENDING_REVIEW",
      paypalCaptureId: `CAPTURE-HELD-${testRunId}`,
    });
    expect(
      (await database.spendReservation.findUniqueOrThrow({ where: { proposalId: proposal.id } }))
        .status,
    ).toBe(ReservationStatus.ACTIVE);
  });

  it("replays an uncertain capture after the proposal expired without re-running policy", async () => {
    const { proposal, snapshot, payment } = await orderFor("retry-after-expiry");
    captureOrder.mockRejectedValueOnce(
      new PayPalProviderError("UPSTREAM_TIMEOUT", undefined, { unknownOutcome: true }),
    );
    expect((await capture(payment.id)).statusCode).toBe(202);
    const pending = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(pending.status).toBe(PaymentStatus.CAPTURE_PENDING);
    await database.purchaseProposal.update({
      where: { id: proposal.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    products.delete(snapshot.externalId);
    const decisions = await database.policyDecision.count({ where: { proposalId: proposal.id } });
    const retried = await capture(payment.id);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().payment.status).toBe(PaymentStatus.COMPLETED);
    expect(captureOrder.mock.calls.at(-1)?.[1]).toBe(pending.paypalCaptureRequestId);
    expect(await database.policyDecision.count({ where: { proposalId: proposal.id } })).toBe(
      decisions,
    );
  });

  it("never moves a PAYMENT_PENDING proposal to BLOCKED when policy blocks", async () => {
    const { proposal, payment } = await orderFor("block-during-capture");
    captureOrder.mockRejectedValueOnce(
      new PayPalProviderError("UPSTREAM_TIMEOUT", undefined, { unknownOutcome: true }),
    );
    expect((await capture(payment.id)).statusCode).toBe(202);
    // Another hold now exhausts the daily limit, so AgentGuard would BLOCK.
    const { proposal: other } = await createProposal(13_900n, "block-filler");
    proposalId = proposal.id;
    const filler = await database.spendReservation.findUniqueOrThrow({
      where: { proposalId: other.id },
    });
    await database.spendReservation.update({
      where: { id: filler.id },
      data: { amount: 999_000n },
    });
    try {
      const blocked = await database.$transaction((tx) =>
        revalidateAuthorizationInTransaction(tx, { id: userA }, proposal.id, undefined, {
          allowedProposalStatuses: ["PAYMENT_PENDING"],
        }),
      );
      expect(blocked.authorized).toBe(false);
      expect(blocked.decision.decision).toBe("BLOCK");
      expect(
        (await database.purchaseProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status,
      ).toBe("PAYMENT_PENDING");
      // The capture retry skips policy entirely and settles the claimed capture.
      const retried = await capture(payment.id);
      expect(retried.json().payment.status).toBe(PaymentStatus.COMPLETED);
    } finally {
      await database.spendReservation.update({
        where: { id: filler.id },
        data: { status: ReservationStatus.RELEASED, releasedAt: new Date() },
      });
    }
  });

  it("reconciles a stale capture on a still-approved order back to the payer, keeping its key", async () => {
    const { proposal, payment } = await orderFor("stale-approved");
    captureOrder.mockRejectedValueOnce(
      new PayPalProviderError("UPSTREAM_TIMEOUT", undefined, { unknownOutcome: true }),
    );
    expect((await capture(payment.id)).statusCode).toBe(202);
    const pending = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const fresh = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${payment.id}/reconcile`,
      headers: headers(userA),
      payload: {},
    });
    expect(fresh.json().payment.status).toBe(PaymentStatus.CAPTURE_PENDING);
    await database.$executeRaw`UPDATE "Payment" SET "updatedAt" = ${new Date(Date.now() - 11 * 60_000)} WHERE id = ${payment.id}`;
    const mutations = captureOrder.mock.calls.length;
    const stale = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${payment.id}/reconcile`,
      headers: headers(userA),
      payload: {},
    });
    expect(stale.json().payment).toMatchObject({
      status: PaymentStatus.APPROVED,
      providerStatusReason: "CAPTURE_NOT_CONFIRMED",
    });
    expect(captureOrder.mock.calls.length).toBe(mutations);
    const after = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.paypalCaptureRequestId).toBe(pending.paypalCaptureRequestId);
    expect(
      (await database.purchaseProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status,
    ).toBe("PAYPAL_ORDER_CREATED");
  });

  it("fails a voided order and releases its hold through read-only reconciliation", async () => {
    const { proposal, payment } = await orderFor("voided");
    getOrder.mockResolvedValueOnce(
      providerOrder({
        id: payment.paypalOrderId,
        status: "VOIDED",
        amount: 13_900,
        referenceId: payment.id,
        customId: proposal.id,
      }),
    );
    const result = await app.inject({
      method: "POST",
      url: `/api/paypal/orders/${payment.id}/reconcile`,
      headers: headers(userA),
      payload: {},
    });
    expect(result.json().payment).toMatchObject({
      status: PaymentStatus.FAILED,
      failureCode: "PAYPAL_ORDER_VOIDED",
    });
    expect(
      (await database.spendReservation.findUniqueOrThrow({ where: { proposalId: proposal.id } }))
        .status,
    ).toBe(ReservationStatus.RELEASED);
  });

  it("sends server-owned line items and rotates the order key after a definitive create rejection", async () => {
    const { proposal } = await createProposal(13_900n, "create-rejected");
    createOrder.mockRejectedValueOnce(rejection("PAYEE_ACCOUNT_RESTRICTED"));
    const rejected = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().code).toBe("PAYPAL_REQUEST_REJECTED");
    const firstKey = createOrder.mock.calls.at(-1)?.[0].requestId;
    expect(createOrder.mock.calls.at(-1)?.[0]).toMatchObject({
      items: [{ quantity: 1, unitAmountMinor: 13_900 }],
      shippingMinor: 0,
      taxMinor: 0,
    });
    const retried = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    expect(retried.statusCode).toBe(200);
    expect(createOrder.mock.calls.at(-1)?.[0].requestId).not.toBe(firstKey);
  });
});
