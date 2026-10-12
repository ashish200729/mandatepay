import Fastify from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuditEventType,
  MandateRepository,
  PaymentProfileStatus,
  PaymentSource,
  PaymentStatus,
  ProductCondition,
  ProposalRepository,
  ProposalStatus,
  ReservationStatus,
  createPrismaClient,
  type DatabaseClient,
} from "@mandatepay/database";
import {
  PayPalProviderError,
  type CreateVaultOrderInput,
  type PayPalCapture,
  type PayPalClient,
  type PayPalOrder,
  type PayPalVaultDeletion,
  type PayPalVaultPaymentToken,
  type PayPalVaultSetupToken,
} from "@mandatepay/paypal";
import { registerPaymentMethodRoutes } from "./routes/payment-methods.js";
import { registerPayPalRoutes } from "./routes/paypal.js";
import {
  VAULT_CONSENT_VERSION,
  startVaultSetup,
  type PaymentMethodContext,
} from "./services/payment-methods.js";
import {
  autopayProposal,
  type DemoProductFacts,
  type PayPalGateway,
  type PaymentServiceContext,
} from "./services/payments.js";
import { approveProposal, evaluateProposal } from "./services/proposals.js";
import { createVaultCipher } from "./services/vault-crypto.js";
import { createPayPalWebhookService } from "./services/webhooks.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl)
  throw new Error("TEST_DATABASE_URL is required for autopay integration tests.");
const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//u, ""));
if (!/_test$/u.test(databaseName) || process.env.DATABASE_URL === testDatabaseUrl) {
  throw new Error("Autopay integration tests require an isolated *_test database.");
}

const database = createPrismaClient(testDatabaseUrl);
const app = Fastify({ logger: false });
const origin = "http://localhost:3000";
const runId = randomUUID().slice(0, 10);
const users = new Set<string>();
const products = new Map<string, DemoProductFacts>();
const vault = createVaultCipher(randomBytes(32).toString("base64"))!;
const TOKEN_PREFIX = `VTOK${runId.replaceAll("-", "")}`;

const createOrder = vi.fn<PayPalGateway["createOrder"]>();
const getOrder = vi.fn<(orderId: string) => Promise<PayPalOrder>>();
const captureOrder = vi.fn<(orderId: string, requestId: string) => Promise<PayPalCapture>>();
const createVaultOrder = vi.fn<(input: CreateVaultOrderInput) => Promise<PayPalOrder>>();
const createVaultSetupToken = vi.fn<(input: unknown) => Promise<PayPalVaultSetupToken>>();
const createVaultPaymentToken = vi.fn<(input: unknown) => Promise<PayPalVaultPaymentToken>>();
const deleteVaultPaymentToken = vi.fn<(id: string) => Promise<PayPalVaultDeletion>>();
const paypal = {
  createOrder,
  getOrder,
  captureOrder,
  createVaultOrder,
  createVaultSetupToken,
  createVaultPaymentToken,
  deleteVaultPaymentToken,
};

const providerOrders = new Map<string, PayPalOrder>();
const lookupDemoProduct = async (externalId: string) => products.get(externalId) ?? null;
const paymentContext: PaymentServiceContext = {
  database,
  paypal,
  appUrl: origin,
  lookupDemoProduct,
  vault,
};

function money(minor: number) {
  return { currency_code: "USD" as const, value: (minor / 100).toFixed(2) };
}

function capture(id: string, amount: number, proposalId: string): PayPalCapture {
  return {
    id,
    status: "COMPLETED",
    amount: money(amount),
    custom_id: proposalId,
    create_time: "2026-10-12T12:00:00Z",
  };
}

function order(
  input: CreateVaultOrderInput,
  status: PayPalOrder["status"],
  extra: { capture?: PayPalCapture; id?: string } = {},
): PayPalOrder {
  const id = extra.id ?? `ORDER-${input.referenceId}`;
  const payerAction = `https://www.sandbox.paypal.com/checkoutnow?token=${id}`;
  return {
    id,
    status,
    links: status === "PAYER_ACTION_REQUIRED" ? [{ href: payerAction, rel: "payer-action" }] : [],
    purchase_units: [
      {
        reference_id: input.referenceId,
        custom_id: input.customId,
        amount: money(input.amountMinor),
        ...(extra.capture ? { payments: { captures: [extra.capture] } } : {}),
      },
    ],
    approvalUrl: status === "PAYER_ACTION_REQUIRED" ? payerAction : null,
  };
}

function completedVaultOrder(input: CreateVaultOrderInput) {
  return order(input, "COMPLETED", {
    capture: capture(`CAP-${input.referenceId}`, input.amountMinor, input.customId),
  });
}

function headers(userId: string) {
  return { "x-test-user": userId, origin, "content-type": "application/json" };
}

async function requireUser(
  request: { headers: Record<string, unknown> },
  reply: { status(code: number): { send(body: unknown): unknown } },
) {
  const id = request.headers["x-test-user"];
  if (typeof id !== "string" || !users.has(id)) {
    await reply.status(401).send({ error: "Unauthorized" });
    return null;
  }
  return { id };
}

interface Fixture {
  userId: string;
  mandateId: string;
  versionId: string;
  tokenId: string;
}

async function createUser(
  label: string,
  options: { saved?: boolean; autonomy?: boolean } = {},
): Promise<Fixture> {
  const user = await database.user.create({
    data: {
      email: `autopay-${label}-${runId}@mandatepay.local`,
      name: `Autopay ${label}`,
      globalAutonomousPurchasingEnabled: options.autonomy ?? true,
    },
  });
  users.add(user.id);
  const now = Date.now();
  const mandate = await new MandateRepository(database).create({
    userId: user.id,
    title: `Autopay mandate ${label}`,
    originalPrompt: "Buy new Sony headphones; automatic up to $200.",
    autoSpendLimit: 20_000n,
    transactionLimit: 30_000n,
    dailyLimit: 1_000_000n,
    weeklyLimit: 1_000_000n,
    monthlyLimit: 1_000_000n,
    startsAt: new Date(now - 60_000),
    expiresAt: new Date(now + 86_400_000),
    status: "ACTIVE",
    canonicalRules: {
      title: `Autopay mandate ${label}`,
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
  const tokenId = `${TOKEN_PREFIX}${label.replace(/[^A-Za-z0-9]/gu, "").slice(0, 20)}`;
  if (options.saved ?? true) {
    await database.paymentProfile.create({
      data: {
        userId: user.id,
        status: PaymentProfileStatus.ACTIVE,
        paypalVaultIdEncrypted: vault.encrypt(user.id, tokenId),
        paypalVaultIdHash: vault.hash(tokenId),
        activatedAt: new Date(),
        consentVersion: VAULT_CONSENT_VERSION,
        consentedAt: new Date(),
      },
    });
  }
  return {
    userId: user.id,
    mandateId: mandate.id,
    versionId: mandate.activeVersionId ?? "",
    tokenId,
  };
}

async function createProposal(
  fixture: Fixture,
  price: bigint,
  key: string,
  options: { source?: string; evaluate?: boolean } = {},
) {
  const unique = `${runId}-${key}`;
  const source = options.source ?? "demo";
  const snapshot = await database.productSnapshot.create({
    data: {
      source,
      externalId: `autopay-${unique}`,
      title: `Autopay headphones ${unique}`,
      brand: "Sony",
      category: "headphones",
      condition: ProductCondition.NEW,
      price,
      currency: "USD",
      merchant: "MandatePay Demo Merchant",
      metadata: { externalId: `autopay-${unique}`, demoSku: `sku-${unique}` },
    },
  });
  products.set(`autopay-${unique}`, {
    externalId: `autopay-${unique}`,
    priceMinor: Number(price),
    currency: "USD",
    brand: "Sony",
    condition: "NEW",
    merchant: "MandatePay Demo Merchant",
    checkoutEligible: true,
    demoSku: `sku-${unique}`,
  });
  const proposal = await new ProposalRepository(database).create({
    userId: fixture.userId,
    mandateId: fixture.mandateId,
    mandateVersionId: fixture.versionId,
    productSnapshotId: snapshot.id,
    quantity: 1,
    shipping: 0n,
    tax: 0n,
    idempotencyKey: `autopay-proposal-${unique}`,
  });
  if (options.evaluate ?? true)
    await evaluateProposal(database, { id: fixture.userId }, proposal.id);
  return proposal.id;
}

async function autopay(userId: string, proposalId: string) {
  return app.inject({
    method: "POST",
    url: `/api/proposals/${proposalId}/autopay`,
    headers: headers(userId),
    payload: {},
  });
}

async function state(proposalId: string) {
  return database.purchaseProposal.findUniqueOrThrow({
    where: { id: proposalId },
    include: { payment: true, reservation: true },
  });
}

async function auditTypes(userId: string) {
  const events = await database.auditEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { eventType: true, payload: true },
  });
  return events;
}

describe("PayPal Vault consent and autonomous payment", () => {
  beforeAll(async () => {
    registerPaymentMethodRoutes(app, {
      database,
      appUrl: origin,
      paypal: paypal as never,
      vault,
      lookupDemoProduct,
      requireUser: requireUser as never,
      isTrustedOrigin: (value) => value === origin,
    });
    registerPayPalRoutes(app, {
      database,
      appUrl: origin,
      paypal,
      lookupDemoProduct,
      requireUser: requireUser as never,
      isTrustedOrigin: (value) => value === origin,
    });
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    providerOrders.clear();
    createVaultOrder.mockImplementation(async (input) => {
      const created = completedVaultOrder(input);
      providerOrders.set(created.id, created);
      return created;
    });
    getOrder.mockImplementation(async (orderId) => {
      const found = providerOrders.get(orderId);
      if (!found) throw new PayPalProviderError("UPSTREAM_REQUEST_FAILED", 404);
      return found;
    });
    deleteVaultPaymentToken.mockResolvedValue({ alreadyAbsent: false });
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it("saves PayPal only after explicit consent and stores the token id encrypted", async () => {
    const fixture = await createUser("consent", { saved: false });
    const approve = `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=SETUP${runId}`;
    createVaultSetupToken.mockResolvedValue({
      id: `SETUP${runId}`.replaceAll("-", ""),
      status: "PAYER_ACTION_REQUIRED",
      customerId: `customer_${runId}`.replaceAll("-", ""),
      approvalUrl: approve,
    });
    const missingConsent = await app.inject({
      method: "POST",
      url: "/api/payment-methods/paypal/setup",
      headers: headers(fixture.userId),
      payload: { consent: false, consentVersion: VAULT_CONSENT_VERSION },
    });
    expect(missingConsent.statusCode).toBe(400);
    const untrusted = await app.inject({
      method: "POST",
      url: "/api/payment-methods/paypal/setup",
      headers: { ...headers(fixture.userId), origin: "https://evil.example" },
      payload: { consent: true, consentVersion: VAULT_CONSENT_VERSION },
    });
    expect(untrusted.statusCode).toBe(403);
    expect(createVaultSetupToken).not.toHaveBeenCalled();

    const started = await app.inject({
      method: "POST",
      url: "/api/payment-methods/paypal/setup",
      headers: headers(fixture.userId),
      payload: { consent: true, consentVersion: VAULT_CONSENT_VERSION },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().approvalUrl).toBe(approve);
    expect(started.json().paymentMethod.status).toBe("SETUP_PENDING");
    const setupInput = createVaultSetupToken.mock.calls[0]?.[0] as Record<string, string>;
    expect(setupInput.returnUrl).toBe(`${origin}/settings?vault=return`);
    expect(setupInput.cancelUrl).toBe(`${origin}/settings?vault=cancel`);
    expect(setupInput.requestId).toHaveLength(36);

    // A repeated start reuses the same PayPal approval link.
    const again = await app.inject({
      method: "POST",
      url: "/api/payment-methods/paypal/setup",
      headers: headers(fixture.userId),
      payload: { consent: true, consentVersion: VAULT_CONSENT_VERSION },
    });
    expect(again.json().approvalUrl).toBe(approve);
    expect(createVaultSetupToken).toHaveBeenCalledTimes(1);

    const tokenId = `${TOKEN_PREFIX}consentflow`;
    createVaultPaymentToken.mockResolvedValue({
      id: tokenId,
      customerId: `customer_${runId}`.replaceAll("-", ""),
      payerEmail: "buyer@example.com",
    });
    const completed = await app.inject({
      method: "POST",
      url: "/api/payment-methods/paypal/complete",
      headers: headers(fixture.userId),
      payload: {},
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().paymentMethod).toMatchObject({
      status: "ACTIVE",
      available: true,
      payerEmail: "b***@example.com",
    });
    expect(completed.body).not.toContain(tokenId);
    expect(createVaultPaymentToken).toHaveBeenCalledWith({
      setupTokenId: `SETUP${runId}`.replaceAll("-", ""),
      requestId: expect.any(String),
    });
    const profile = await database.paymentProfile.findUniqueOrThrow({
      where: { userId: fixture.userId },
    });
    expect(profile.status).toBe(PaymentProfileStatus.ACTIVE);
    expect(profile.paypalVaultIdEncrypted).not.toContain(tokenId);
    expect(vault.decrypt(fixture.userId, profile.paypalVaultIdEncrypted ?? "")).toBe(tokenId);
    expect(profile.setupTokenId).toBeNull();

    // Completing again is idempotent and does not call PayPal.
    const repeat = await app.inject({
      method: "POST",
      url: "/api/payment-methods/paypal/complete",
      headers: headers(fixture.userId),
      payload: {},
    });
    expect(repeat.json().paymentMethod.status).toBe("ACTIVE");
    expect(createVaultPaymentToken).toHaveBeenCalledTimes(1);

    const read = await app.inject({
      method: "GET",
      url: "/api/payment-methods/paypal",
      headers: headers(fixture.userId),
    });
    expect(read.json().paymentMethod.status).toBe("ACTIVE");
    expect(read.body).not.toContain(tokenId);
    expect(read.body).not.toContain("customer_");
    const events = (await auditTypes(fixture.userId)).map((event) => event.eventType);
    expect(events).toEqual(
      expect.arrayContaining([
        AuditEventType.PAYMENT_METHOD_SETUP_STARTED,
        AuditEventType.PAYMENT_METHOD_SAVED,
      ]),
    );
    expect(JSON.stringify(await auditTypes(fixture.userId))).not.toContain(tokenId);
  });

  it("refuses to enable vaulting without a valid encryption key", async () => {
    const fixture = await createUser("nokey", { saved: false });
    const context: PaymentMethodContext = { database, paypal, appUrl: origin, vault: null };
    await expect(startVaultSetup(context, { id: fixture.userId })).rejects.toMatchObject({
      code: "VAULT_UNAVAILABLE",
    });
    expect(createVaultSetupToken).not.toHaveBeenCalled();
  });

  it("does not save anything when PayPal reports the setup was not approved", async () => {
    const fixture = await createUser("notapproved", { saved: false });
    createVaultSetupToken.mockResolvedValue({
      id: `SETUPNA${runId}`.replaceAll("-", ""),
      status: "PAYER_ACTION_REQUIRED",
      customerId: null,
      approvalUrl: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=x",
    });
    await app.inject({
      method: "POST",
      url: "/api/payment-methods/paypal/setup",
      headers: headers(fixture.userId),
      payload: { consent: true, consentVersion: VAULT_CONSENT_VERSION },
    });
    createVaultPaymentToken.mockRejectedValue(
      new PayPalProviderError("UPSTREAM_REQUEST_FAILED", 422, {
        details: { name: "UNPROCESSABLE_ENTITY", issue: "SETUP_TOKEN_NOT_APPROVED", debugId: null },
      }),
    );
    const completed = await app.inject({
      method: "POST",
      url: "/api/payment-methods/paypal/complete",
      headers: headers(fixture.userId),
      payload: {},
    });
    expect(completed.statusCode).toBe(409);
    expect(completed.json().code).toBe("SETUP_NOT_APPROVED");
    const profile = await database.paymentProfile.findUniqueOrThrow({
      where: { userId: fixture.userId },
    });
    expect(profile.status).toBe(PaymentProfileStatus.DISCONNECTED);
    expect(profile.paypalVaultIdEncrypted).toBeNull();
  });

  it("pays an AgentGuard ALLOW proposal buyer-not-present and is idempotent on retry", async () => {
    const fixture = await createUser("paid");
    const proposalId = await createProposal(fixture, 13_900n, "paid");
    expect((await state(proposalId)).status).toBe(ProposalStatus.AUTHORIZED);

    const response = await autopay(fixture.userId, proposalId);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.autopay.outcome).toBe("PAID");
    expect(body.autopay.payment).toMatchObject({
      status: "COMPLETED",
      amount: 13_900,
      paymentSource: "vault",
    });
    expect(body.proposal.status).toBe("COMPLETED");
    expect(createVaultOrder).toHaveBeenCalledTimes(1);
    const input = createVaultOrder.mock.calls[0]![0];
    expect(input.vaultId).toBe(fixture.tokenId);
    expect(input.amountMinor).toBe(13_900);
    expect(input.customId).toBe(proposalId);
    expect(input.items?.[0]?.unitAmountMinor).toBe(13_900);
    const stored = await state(proposalId);
    expect(stored.payment?.paypalOrderRequestId).toBe(input.requestId);
    expect(stored.payment?.paymentSource).toBe(PaymentSource.VAULT);
    expect(stored.payment?.paypalCaptureId).toBe(`CAP-${stored.payment?.id}`);
    expect(stored.reservation?.status).toBe(ReservationStatus.CONSUMED);
    expect(captureOrder).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(fixture.tokenId);

    const retry = await autopay(fixture.userId, proposalId);
    expect(retry.json().autopay.outcome).toBe("PAID");
    expect(retry.json().autopay.payment.id).toBe(body.autopay.payment.id);
    expect(createVaultOrder).toHaveBeenCalledTimes(1);
    const events = (await auditTypes(fixture.userId)).map((event) => event.eventType);
    expect(
      events.filter((type) => type === AuditEventType.AUTONOMOUS_PAYMENT_STARTED),
    ).toHaveLength(1);
    expect(
      events.filter((type) => type === AuditEventType.AUTONOMOUS_PAYMENT_COMPLETED),
    ).toHaveLength(1);
    expect(events).toContain(AuditEventType.PAYMENT_CAPTURED);
  });

  it("serializes concurrent autopay requests into one provider order", async () => {
    const fixture = await createUser("concurrent");
    const proposalId = await createProposal(fixture, 13_900n, "concurrent");
    const responses = await Promise.all([0, 1, 2].map(() => autopay(fixture.userId, proposalId)));
    const ids = new Set(responses.map((response) => response.json().autopay.payment?.id));
    expect(ids.size).toBe(1);
    expect(createVaultOrder).toHaveBeenCalledTimes(1);
    expect((await state(proposalId)).payment?.status).toBe(PaymentStatus.COMPLETED);
  });

  it("refuses REQUIRE_APPROVAL, above-limit and human-approved proposals", async () => {
    const fixture = await createUser("approval");
    const aboveLimit = await createProposal(fixture, 25_000n, "above-limit");
    expect((await state(aboveLimit)).status).toBe(ProposalStatus.AWAITING_APPROVAL);
    const waiting = await autopay(fixture.userId, aboveLimit);
    expect(waiting.json().autopay).toMatchObject({
      outcome: "NOT_ELIGIBLE",
      reason: "PROPOSAL_NOT_AUTHORIZED",
    });
    await approveProposal(database, { id: fixture.userId }, aboveLimit);
    expect((await state(aboveLimit)).status).toBe(ProposalStatus.AUTHORIZED);
    const approvedAbove = await autopay(fixture.userId, aboveLimit);
    expect(approvedAbove.json().autopay).toMatchObject({
      outcome: "NOT_ELIGIBLE",
      reason: "ABOVE_AUTOMATIC_LIMIT",
    });

    // Within the limit but human-approved (autonomy was off when evaluated).
    await database.user.update({
      where: { id: fixture.userId },
      data: { globalAutonomousPurchasingEnabled: false },
    });
    const humanApproved = await createProposal(fixture, 13_900n, "human-approved");
    expect((await state(humanApproved)).status).toBe(ProposalStatus.AWAITING_APPROVAL);
    await approveProposal(database, { id: fixture.userId }, humanApproved);
    await database.user.update({
      where: { id: fixture.userId },
      data: { globalAutonomousPurchasingEnabled: true },
    });
    const refused = await autopay(fixture.userId, humanApproved);
    expect(refused.json().autopay).toMatchObject({
      outcome: "NOT_ELIGIBLE",
      reason: "HUMAN_APPROVED",
    });
    expect(createVaultOrder).not.toHaveBeenCalled();
    expect((await state(humanApproved)).payment).toBeNull();
    expect((await state(humanApproved)).status).toBe(ProposalStatus.AUTHORIZED);
  });

  it("refuses when user autonomy is off, without changing the proposal", async () => {
    const fixture = await createUser("autonomy-off");
    const proposalId = await createProposal(fixture, 13_900n, "autonomy-off");
    await database.user.update({
      where: { id: fixture.userId },
      data: { globalAutonomousPurchasingEnabled: false },
    });
    const response = await autopay(fixture.userId, proposalId);
    expect(response.json().autopay).toMatchObject({
      outcome: "NOT_ELIGIBLE",
      reason: "AUTONOMY_OFF",
    });
    expect((await state(proposalId)).status).toBe(ProposalStatus.AUTHORIZED);
    expect((await state(proposalId)).payment).toBeNull();
    expect(createVaultOrder).not.toHaveBeenCalled();
  });

  it("refuses when platform autonomy is off, including inside the locked claim", async () => {
    const fixture = await createUser("platform-off");
    const proposalId = await createProposal(fixture, 13_900n, "platform-off");
    const rows = [{ key: "payments.autonomyEnabledGlobally", valueJson: false }];
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
    const result = await autopayProposal(
      { ...paymentContext, database: override(database) as DatabaseClient },
      { id: fixture.userId },
      proposalId,
    );
    expect(result).toMatchObject({ outcome: "NOT_ELIGIBLE", reason: "PLATFORM_AUTONOMY_OFF" });
    expect(createVaultOrder).not.toHaveBeenCalled();
    expect((await state(proposalId)).payment).toBeNull();
  });

  it("refuses without an ACTIVE saved method and for Channel3 products", async () => {
    const fixture = await createUser("revoked");
    await database.paymentProfile.update({
      where: { userId: fixture.userId },
      data: { status: PaymentProfileStatus.REVOKED, paypalVaultIdEncrypted: null },
    });
    const proposalId = await createProposal(fixture, 13_900n, "revoked");
    const response = await autopay(fixture.userId, proposalId);
    expect(response.json().autopay).toMatchObject({
      outcome: "NOT_ELIGIBLE",
      reason: "NO_SAVED_PAYMENT_METHOD",
    });
    const preview = await app.inject({
      method: "GET",
      url: `/api/proposals/${proposalId}/autopay`,
      headers: headers(fixture.userId),
    });
    expect(preview.json().autopay).toMatchObject({
      eligible: false,
      reason: "NO_SAVED_PAYMENT_METHOD",
      paymentMethodStatus: "REVOKED",
    });

    const external = await createUser("channel3");
    const externalProposal = await createProposal(external, 13_900n, "channel3", {
      source: "channel3",
    });
    const externalResponse = await autopay(external.userId, externalProposal);
    expect(externalResponse.json().autopay).toMatchObject({
      outcome: "NOT_ELIGIBLE",
      reason: expect.stringMatching(/^(PRODUCT_NOT_ELIGIBLE|PROPOSAL_NOT_AUTHORIZED)$/u),
    });
    expect(createVaultOrder).not.toHaveBeenCalled();
  });

  it("keeps ownership: another user cannot pay or preview the proposal", async () => {
    const owner = await createUser("owner");
    const other = await createUser("other");
    const proposalId = await createProposal(owner, 13_900n, "owner");
    expect((await autopay(other.userId, proposalId)).statusCode).toBe(404);
    const unauthenticated = await app.inject({
      method: "POST",
      url: `/api/proposals/${proposalId}/autopay`,
      headers: { origin, "content-type": "application/json" },
      payload: {},
    });
    expect(unauthenticated.statusCode).toBe(401);
    const untrusted = await app.inject({
      method: "POST",
      url: `/api/proposals/${proposalId}/autopay`,
      headers: { ...headers(owner.userId), origin: "https://evil.example" },
      payload: {},
    });
    expect(untrusted.statusCode).toBe(403);
    expect(createVaultOrder).not.toHaveBeenCalled();
  });

  it("falls back to buyer approval without charging when PayPal needs payer action", async () => {
    const fixture = await createUser("payer-action");
    const proposalId = await createProposal(fixture, 13_900n, "payer-action");
    let vaultOrder: PayPalOrder | null = null;
    createVaultOrder.mockImplementation(async (input) => {
      vaultOrder = order(input, "PAYER_ACTION_REQUIRED");
      return vaultOrder;
    });
    const response = await autopay(fixture.userId, proposalId);
    expect(response.json().autopay.outcome).toBe("FALLBACK");
    const stored = await state(proposalId);
    expect(stored.status).toBe(ProposalStatus.PAYPAL_ORDER_CREATED);
    expect(stored.payment).toMatchObject({
      status: PaymentStatus.CREATED,
      paymentSource: PaymentSource.CHECKOUT,
      paypalCaptureId: null,
      paypalOrderId: vaultOrder!.id,
    });
    expect(stored.payment?.payerActionUrl).toContain("www.sandbox.paypal.com");
    expect(stored.reservation?.status).toBe(ReservationStatus.ACTIVE);
    expect(captureOrder).not.toHaveBeenCalled();

    // The normal checkout continues with the same order; nothing new is created.
    getOrder.mockResolvedValue(vaultOrder!);
    const checkout = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(fixture.userId),
      payload: { proposalId },
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json().approvalUrl).toContain("www.sandbox.paypal.com");
    expect(createOrder).not.toHaveBeenCalled();
    const retry = await autopay(fixture.userId, proposalId);
    expect(retry.json().autopay).toMatchObject({
      outcome: "NOT_ELIGIBLE",
      reason: "CHECKOUT_STARTED",
    });
    expect(createVaultOrder).toHaveBeenCalledTimes(1);
    expect((await auditTypes(fixture.userId)).map((event) => event.eventType)).toContain(
      AuditEventType.AUTONOMOUS_PAYMENT_FALLBACK,
    );
  });

  it("falls back to a fresh checkout when PayPal has not enabled vault payments", async () => {
    const fixture = await createUser("not-enabled");
    const proposalId = await createProposal(fixture, 13_900n, "not-enabled");
    createVaultOrder.mockRejectedValue(
      new PayPalProviderError("UPSTREAM_REQUEST_FAILED", 422, {
        details: {
          name: "UNPROCESSABLE_ENTITY",
          issue: "NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE",
          debugId: "debug-vault",
        },
      }),
    );
    const response = await autopay(fixture.userId, proposalId);
    expect(response.json().autopay).toMatchObject({
      outcome: "FALLBACK",
      reason: "NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE",
    });
    const stored = await state(proposalId);
    const requestId = createVaultOrder.mock.calls[0]![0].requestId;
    expect(stored.status).toBe(ProposalStatus.AUTHORIZED);
    expect(stored.payment).toMatchObject({
      status: PaymentStatus.CREATED,
      paymentSource: PaymentSource.CHECKOUT,
      paypalOrderId: null,
    });
    expect(stored.payment?.paypalOrderRequestId).not.toBe(requestId);
    expect(stored.reservation?.status).toBe(ReservationStatus.ACTIVE);

    createOrder.mockImplementation(async (input) => ({
      id: `ORDER-CHECKOUT-${input.referenceId}`,
      status: "PAYER_ACTION_REQUIRED",
      links: [],
      purchase_units: [
        {
          reference_id: input.referenceId,
          custom_id: input.customId,
          amount: money(input.amountMinor),
        },
      ],
      approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=ORDER-CHECKOUT-${input.referenceId}`,
    }));
    const checkout = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(fixture.userId),
      payload: { proposalId },
    });
    expect(checkout.statusCode).toBe(200);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder.mock.calls[0]?.[0].requestId).toBe(stored.payment?.paypalOrderRequestId);
  });

  it("fails and releases the reservation after a definitive PayPal rejection", async () => {
    const fixture = await createUser("rejected");
    const proposalId = await createProposal(fixture, 13_900n, "rejected");
    createVaultOrder.mockRejectedValue(
      new PayPalProviderError("UPSTREAM_REQUEST_FAILED", 422, {
        details: { name: "UNPROCESSABLE_ENTITY", issue: "PAYEE_ACCOUNT_RESTRICTED", debugId: null },
      }),
    );
    const response = await autopay(fixture.userId, proposalId);
    expect(response.json().autopay).toMatchObject({
      outcome: "FAILED",
      reason: "PAYPAL_VAULT_ORDER_REJECTED:PAYEE_ACCOUNT_RESTRICTED",
    });
    const stored = await state(proposalId);
    expect(stored.status).toBe(ProposalStatus.FAILED);
    expect(stored.payment?.status).toBe(PaymentStatus.FAILED);
    expect(stored.reservation?.status).toBe(ReservationStatus.RELEASED);
    const events = (await auditTypes(fixture.userId)).map((event) => event.eventType);
    expect(events).toContain(AuditEventType.AUTONOMOUS_PAYMENT_FAILED);
    expect(events).toContain(AuditEventType.SPEND_RESERVATION_RELEASED);
    const retry = await autopay(fixture.userId, proposalId);
    expect(retry.json().autopay.outcome).toBe("FAILED");
    expect(createVaultOrder).toHaveBeenCalledTimes(1);
  });

  it("keeps an uncertain outcome pending with its reservation held, then replays the same request", async () => {
    const fixture = await createUser("uncertain");
    const proposalId = await createProposal(fixture, 13_900n, "uncertain");
    createVaultOrder.mockRejectedValueOnce(
      new PayPalProviderError("UPSTREAM_UNAVAILABLE", 503, {
        retryable: true,
        unknownOutcome: true,
      }),
    );
    const first = await autopay(fixture.userId, proposalId);
    expect(first.statusCode).toBe(202);
    expect(first.json().autopay).toMatchObject({
      outcome: "PENDING",
      reason: "PAYPAL_OUTCOME_UNKNOWN",
    });
    const pending = await state(proposalId);
    expect(pending.status).toBe(ProposalStatus.PAYMENT_PENDING);
    expect(pending.payment?.status).toBe(PaymentStatus.CAPTURE_PENDING);
    expect(pending.reservation?.status).toBe(ReservationStatus.ACTIVE);

    const second = await autopay(fixture.userId, proposalId);
    expect(second.json().autopay.outcome).toBe("PAID");
    expect(createVaultOrder).toHaveBeenCalledTimes(2);
    expect(createVaultOrder.mock.calls[1]![0].requestId).toBe(
      createVaultOrder.mock.calls[0]![0].requestId,
    );
  });

  it("binds and settles an unbound Vault payment from a verified order webhook", async () => {
    const fixture = await createUser("webhook-bind");
    const proposalId = await createProposal(fixture, 13_900n, "webhook-bind");
    let lost: CreateVaultOrderInput | null = null;
    createVaultOrder.mockImplementationOnce(async (input) => {
      lost = input;
      throw new PayPalProviderError("UPSTREAM_TIMEOUT", undefined, {
        retryable: true,
        unknownOutcome: true,
      });
    });
    expect((await autopay(fixture.userId, proposalId)).json().autopay.outcome).toBe("PENDING");
    const completed = completedVaultOrder(lost!);
    const fakePayPal = {
      getOrder: vi.fn().mockResolvedValue(completed),
    } as unknown as PayPalClient;
    const service = createPayPalWebhookService(database, fakePayPal, { vaultCipher: vault });
    const outcome = await service.replayVerified({
      inboxId: "unused",
      event: {
        id: `WH-BIND-${runId}`,
        event_type: "CHECKOUT.ORDER.COMPLETED",
        resource: { id: completed.id },
      },
    });
    expect(outcome).toBe("processed");
    const stored = await state(proposalId);
    expect(stored.payment).toMatchObject({
      status: PaymentStatus.COMPLETED,
      paypalOrderId: completed.id,
    });
    expect(stored.reservation?.status).toBe(ReservationStatus.CONSUMED);
  });

  it("removes a saved method at PayPal and never charges it afterwards", async () => {
    const fixture = await createUser("remove");
    deleteVaultPaymentToken.mockRejectedValueOnce(
      new PayPalProviderError("UPSTREAM_UNAVAILABLE", 503, { retryable: true }),
    );
    const pending = await app.inject({
      method: "POST",
      url: "/api/payment-methods/paypal/remove",
      headers: headers(fixture.userId),
      payload: {},
    });
    expect(pending.statusCode).toBe(202);
    expect(pending.json().paymentMethod.status).toBe("REMOVAL_PENDING");
    expect(deleteVaultPaymentToken).toHaveBeenCalledWith(fixture.tokenId);

    const proposalId = await createProposal(fixture, 13_900n, "remove");
    const refused = await autopay(fixture.userId, proposalId);
    expect(refused.json().autopay).toMatchObject({
      outcome: "NOT_ELIGIBLE",
      reason: "NO_SAVED_PAYMENT_METHOD",
    });

    // The next look at Settings retries the PayPal deletion.
    const read = await app.inject({
      method: "GET",
      url: "/api/payment-methods/paypal",
      headers: headers(fixture.userId),
    });
    expect(read.json().paymentMethod.status).toBe("REVOKED");
    expect(deleteVaultPaymentToken).toHaveBeenCalledTimes(2);
    const profile = await database.paymentProfile.findUniqueOrThrow({
      where: { userId: fixture.userId },
    });
    expect(profile.paypalVaultIdEncrypted).toBeNull();
    expect(profile.revokedAt).not.toBeNull();

    const again = await app.inject({
      method: "POST",
      url: "/api/payment-methods/paypal/remove",
      headers: headers(fixture.userId),
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(deleteVaultPaymentToken).toHaveBeenCalledTimes(2);
    expect(createVaultOrder).not.toHaveBeenCalled();
    const events = (await auditTypes(fixture.userId)).map((event) => event.eventType);
    expect(events).toEqual(
      expect.arrayContaining([
        AuditEventType.PAYMENT_METHOD_REMOVAL_REQUESTED,
        AuditEventType.PAYMENT_METHOD_REVOKED,
      ]),
    );
  });

  it("treats PayPal 404 on removal as already removed", async () => {
    const fixture = await createUser("remove-404");
    deleteVaultPaymentToken.mockResolvedValueOnce({ alreadyAbsent: true });
    const removed = await app.inject({
      method: "POST",
      url: "/api/payment-methods/paypal/remove",
      headers: headers(fixture.userId),
      payload: {},
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().paymentMethod.status).toBe("REVOKED");
  });

  it("revokes the method from a verified VAULT.PAYMENT-TOKEN.DELETED webhook", async () => {
    const fixture = await createUser("webhook-delete");
    const lookup = vi.fn();
    const fakePayPal = { getVaultPaymentToken: lookup } as unknown as PayPalClient;
    const service = createPayPalWebhookService(database, fakePayPal, { vaultCipher: vault });

    lookup.mockResolvedValueOnce({ id: fixture.tokenId, customerId: null, payerEmail: null });
    expect(
      await service.replayVerified({
        inboxId: "unused",
        event: {
          id: `WH-CREATED-${runId}`,
          event_type: "VAULT.PAYMENT-TOKEN.CREATED",
          resource: { id: fixture.tokenId },
        },
      }),
    ).toBe("processed");
    expect(
      (await database.paymentProfile.findUniqueOrThrow({ where: { userId: fixture.userId } }))
        .status,
    ).toBe(PaymentProfileStatus.ACTIVE);

    lookup.mockRejectedValueOnce(new PayPalProviderError("UPSTREAM_REQUEST_FAILED", 404));
    const deleted = {
      id: `WH-DELETED-${runId}`,
      event_type: "VAULT.PAYMENT-TOKEN.DELETED",
      resource: { id: fixture.tokenId },
    };
    expect(await service.replayVerified({ inboxId: "unused", event: deleted })).toBe("processed");
    const profile = await database.paymentProfile.findUniqueOrThrow({
      where: { userId: fixture.userId },
    });
    expect(profile.status).toBe(PaymentProfileStatus.REVOKED);
    expect(profile.paypalVaultIdEncrypted).toBeNull();

    lookup.mockRejectedValueOnce(new PayPalProviderError("UPSTREAM_REQUEST_FAILED", 404));
    expect(await service.replayVerified({ inboxId: "unused", event: deleted })).toBe("processed");
    lookup.mockRejectedValueOnce(new PayPalProviderError("UPSTREAM_REQUEST_FAILED", 404));
    expect(
      await service.replayVerified({
        inboxId: "unused",
        event: { ...deleted, id: `WH-UNKNOWN-${runId}`, resource: { id: "UNKNOWNTOKEN" } },
      }),
    ).toBe("ignored");

    const proposalId = await createProposal(fixture, 13_900n, "webhook-delete");
    const refused = await autopay(fixture.userId, proposalId);
    expect(refused.json().autopay.reason).toBe("NO_SAVED_PAYMENT_METHOD");
  });
});
