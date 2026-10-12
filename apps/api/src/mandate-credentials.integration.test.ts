import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuditEventType,
  MandateRepository,
  ProductCondition,
  ProposalRepository,
  ProposalStatus,
  createPrismaClient,
} from "@mandatepay/database";
import type { PayPalCapture, PayPalOrder } from "@mandatepay/paypal";
import { CanonicalMandateSchema } from "@mandatepay/shared";
import { registerCredentialRoutes, registerPublicCredentialRoutes } from "./routes/credentials.js";
import { registerMandateRoutes } from "./routes/mandates.js";
import { registerPayPalRoutes } from "./routes/paypal.js";
import { registerProposalRoutes } from "./routes/proposals.js";
import {
  checkoutFacts,
  computeCheckoutHash,
  configureMandateSigning,
} from "./services/mandate-credentials.js";
import { canonicalToCreateInput } from "./services/mandates.js";
import type { DemoProductFacts, PayPalGateway } from "./services/payments.js";
import { evaluateProposalInTransaction } from "./services/proposals.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl)
  throw new Error("TEST_DATABASE_URL is required for mandate credential integration tests.");
const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//u, ""));
if (!/_test$/u.test(databaseName) || process.env.DATABASE_URL === testDatabaseUrl) {
  throw new Error("Mandate credential integration tests require an isolated *_test database.");
}

const database = createPrismaClient(testDatabaseUrl);
const app = Fastify({ logger: false });
const origin = "http://localhost:3000";
const issuer = "http://localhost:4000";
const runId = randomUUID().slice(0, 10);
const users = new Set<string>();
const products = new Map<string, DemoProductFacts>();
let userA = "";
let userB = "";

const createOrder = vi.fn<PayPalGateway["createOrder"]>();
const getOrder = vi.fn<(orderId: string) => Promise<PayPalOrder>>();
const captureOrder = vi.fn<(orderId: string, requestId: string) => Promise<PayPalCapture>>();

function headers(userId: string) {
  return { "x-test-user": userId, origin, "content-type": "application/json" };
}

const requireUser = async (
  request: { headers: Record<string, unknown> },
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
) => {
  const id = request.headers["x-test-user"];
  if (typeof id !== "string" || !users.has(id)) {
    await reply.status(401).send({ error: "Unauthorized" });
    return null;
  }
  return { id };
};

function canonical(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return CanonicalMandateSchema.parse({
    title: "Credential mandate",
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
    blockedMerchants: ["Shady Shop"],
    newMerchantRequiresApproval: false,
    startsAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    ...overrides,
  });
}

async function createMandate(userId: string, status: "DRAFT" | "ACTIVE", key: string) {
  return new MandateRepository(database).create({
    ...canonicalToCreateInput(userId, "Buy new Sony headphones.", canonical()),
    creationRequestKey: `${runId}-${key}`,
    status,
  });
}

async function createProposal(
  userId: string,
  mandate: { id: string; activeVersionId: string | null },
  price: bigint,
  key: string,
) {
  const unique = `${runId}-${key}`;
  const snapshot = await database.productSnapshot.create({
    data: {
      source: "demo",
      externalId: "credential-product-" + unique,
      title: "Demo headphones " + unique,
      brand: "Sony",
      category: "headphones",
      condition: ProductCondition.NEW,
      price,
      currency: "USD",
      merchant: "MandatePay Demo Merchant",
      metadata: { externalId: "credential-product-" + unique, demoSku: "sku-" + unique },
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
    demoSku: "sku-" + unique,
  });
  return new ProposalRepository(database).create({
    userId,
    mandateId: mandate.id,
    mandateVersionId: mandate.activeVersionId ?? "",
    productSnapshotId: snapshot.id,
    quantity: 1,
    shipping: 0n,
    tax: 0n,
    idempotencyKey: "credential-proposal-" + unique,
  });
}

async function evaluate(userId: string, proposalId: string) {
  const response = await app.inject({
    method: "POST",
    url: `/api/proposals/${proposalId}/evaluate`,
    headers: headers(userId),
    payload: {},
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { proposal: { status: string } };
}

async function proposalCredentials(userId: string, proposalId: string) {
  return app.inject({
    method: "GET",
    url: `/api/proposals/${proposalId}/credentials`,
    headers: headers(userId),
  });
}

describe("verifiable AP2-shaped mandate credentials", () => {
  beforeAll(async () => {
    await configureMandateSigning({ issuer, nodeEnv: "test" });
    for (const [label, assign] of [
      ["a", (id: string) => (userA = id)],
      ["b", (id: string) => (userB = id)],
    ] as const) {
      const user = await database.user.create({
        data: {
          email: `credential-${label}-${runId}@mandatepay.local`,
          name: `Credential ${label}`,
          globalAutonomousPurchasingEnabled: true,
        },
      });
      assign(user.id);
      users.add(user.id);
    }
    const context = {
      database,
      requireUser: requireUser as never,
      isTrustedOrigin: (value: string | undefined) => value === origin,
    };
    registerPublicCredentialRoutes(app, { verifyMaximum: 500 });
    registerCredentialRoutes(app, context);
    registerMandateRoutes(app, {
      ...context,
      parseDraft: async () => {
        throw new Error("not used");
      },
    });
    registerProposalRoutes(app, context);
    registerPayPalRoutes(app, {
      ...context,
      appUrl: origin,
      paypal: { createOrder, getOrder, captureOrder },
      lookupDemoProduct: async (externalId) => products.get(externalId) ?? null,
    });
    await app.ready();
  });

  beforeEach(() => {
    createOrder.mockReset();
    createOrder.mockImplementation(async (input) => ({
      id: "ORDER-" + input.referenceId,
      status: "CREATED",
      links: [],
      purchase_units: [
        {
          reference_id: input.referenceId,
          custom_id: input.customId,
          amount: { currency_code: "USD", value: (Number(input.amountMinor) / 100).toFixed(2) },
        },
      ],
      approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-" + input.referenceId,
    }));
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it("issues open payment and checkout credentials when the user activates a mandate", async () => {
    const mandate = await createMandate(userA, "DRAFT", "activate");
    const draft = await app.inject({
      method: "GET",
      url: `/api/mandates/${mandate.id}/credentials`,
      headers: headers(userA),
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ mandateStatus: "DRAFT", credentials: [] });

    const activated = await app.inject({
      method: "POST",
      url: `/api/mandates/${mandate.id}/activate`,
      headers: headers(userA),
      payload: { version: 1 },
    });
    expect(activated.statusCode).toBe(200);
    const rows = await database.mandateCredential.findMany({
      where: { mandateVersionId: mandate.activeVersionId ?? "" },
      orderBy: { kind: "asc" },
    });
    expect(rows.map((row) => row.kind).sort()).toEqual(["OPEN_CHECKOUT", "OPEN_PAYMENT"]);
    expect(rows.every((row) => row.proposalId === null && row.digest.length === 64)).toBe(true);
    expect(
      await database.auditEvent.count({
        where: {
          eventType: AuditEventType.MANDATE_CREDENTIAL_ISSUED,
          entityId: mandate.activeVersionId ?? "",
        },
      }),
    ).toBe(2);

    const response = await app.inject({
      method: "GET",
      url: `/api/mandates/${mandate.id}/credentials`,
      headers: headers(userA),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    const body = response.json() as {
      mandateStatus: string;
      credentials: Array<{
        id: string;
        kind: string;
        vct: string;
        verified: boolean;
        constraints: Array<{ type: string }>;
        jwt: string;
      }>;
    };
    expect(body.mandateStatus).toBe("ACTIVE");
    expect(body.credentials.map((item) => item.id).sort()).toEqual(
      rows.map((row) => row.id).sort(),
    );
    const payment = body.credentials.find((item) => item.kind === "OPEN_PAYMENT")!;
    expect(payment).toMatchObject({ vct: "mandate.payment.open.1", verified: true });
    expect(payment.constraints).toContainEqual({
      type: "payment.amount_range",
      currency: "USD",
      min: 0,
      max: 30_000,
    });
    // No email or other PII in the signed payload.
    const payload = Buffer.from(payment.jwt.split(".")[1]!, "base64url").toString("utf8");
    expect(payload).not.toContain("@mandatepay.local");
    expect(payload).not.toContain(userA);

    // Ownership: another user cannot read the credentials.
    const foreign = await app.inject({
      method: "GET",
      url: `/api/mandates/${mandate.id}/credentials`,
      headers: headers(userB),
    });
    expect(foreign.statusCode).toBe(404);

    // Append-only: the database rejects changes to issued credentials.
    await expect(
      database.mandateCredential.update({ where: { id: rows[0]!.id }, data: { kid: "x" } }),
    ).rejects.toBeDefined();
    await expect(
      database.mandateCredential.delete({ where: { id: rows[0]!.id } }),
    ).rejects.toBeDefined();
  });

  it("re-signs a versioned edit and lazily issues for a mandate activated elsewhere", async () => {
    const mandate = await createMandate(userA, "ACTIVE", "lazy");
    expect(await database.mandateCredential.count({ where: { mandateId: mandate.id } })).toBe(0);
    const first = await app.inject({
      method: "GET",
      url: `/api/mandates/${mandate.id}/credentials`,
      headers: headers(userA),
    });
    const second = await app.inject({
      method: "GET",
      url: `/api/mandates/${mandate.id}/credentials`,
      headers: headers(userA),
    });
    const ids = (value: typeof first) =>
      (value.json() as { credentials: Array<{ id: string }> }).credentials.map((item) => item.id);
    expect(ids(first)).toHaveLength(2);
    expect(ids(second)).toEqual(ids(first));

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/mandates/${mandate.id}`,
      headers: headers(userA),
      payload: {
        version: 1,
        originalPrompt: "Buy new Sony headphones up to $250.",
        mandate: canonical({ transactionLimit: 25_000 }),
      },
    });
    expect(edited.statusCode).toBe(200);
    const current = await database.mandate.findUniqueOrThrow({ where: { id: mandate.id } });
    const versionRows = await database.mandateCredential.findMany({
      where: { mandateVersionId: current.activeVersionId ?? "" },
    });
    expect(versionRows).toHaveLength(2);
    const afterEdit = await app.inject({
      method: "GET",
      url: `/api/mandates/${mandate.id}/credentials`,
      headers: headers(userA),
    });
    const body = afterEdit.json() as {
      version: number;
      credentials: Array<{ kind: string; constraints: Array<Record<string, unknown>> }>;
    };
    expect(body.version).toBe(2);
    expect(
      body.credentials
        .find((item) => item.kind === "OPEN_PAYMENT")
        ?.constraints.find((item) => item.type === "payment.amount_range"),
    ).toMatchObject({ max: 25_000 });
  });

  it("issues closed cart mandates on AgentGuard ALLOW and on explicit human approval", async () => {
    const mandate = await createMandate(userA, "ACTIVE", "closed");
    const allowed = await createProposal(userA, mandate, 13_900n, "allow");
    expect((await evaluate(userA, allowed.id)).proposal.status).toBe(ProposalStatus.AUTHORIZED);
    const response = await proposalCredentials(userA, allowed.id);
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      hashVerified: boolean;
      checkoutHash: string;
      credentials: Array<{ kind: string; vct: string; verified: boolean }>;
    };
    const stored = await database.purchaseProposal.findUniqueOrThrow({
      where: { id: allowed.id },
      include: { productSnapshot: true },
    });
    expect(body.hashVerified).toBe(true);
    expect(body.checkoutHash).toBe(computeCheckoutHash(checkoutFacts(stored)));
    expect(body.credentials.map((item) => item.vct).sort()).toEqual([
      "mandate.checkout.1",
      "mandate.payment.1",
    ]);
    expect(body.credentials.every((item) => item.verified)).toBe(true);
    expect((await proposalCredentials(userB, allowed.id)).statusCode).toBe(404);

    // Above the automatic limit: nothing is signed until the user approves.
    const reviewed = await createProposal(userA, mandate, 25_000n, "approve");
    expect((await evaluate(userA, reviewed.id)).proposal.status).toBe(
      ProposalStatus.AWAITING_APPROVAL,
    );
    expect(await database.mandateCredential.count({ where: { proposalId: reviewed.id } })).toBe(0);
    const pending = (await proposalCredentials(userA, reviewed.id)).json() as {
      hashVerified: boolean;
      credentials: unknown[];
    };
    expect(pending).toMatchObject({ hashVerified: false, credentials: [] });
    const approved = await app.inject({
      method: "POST",
      url: `/api/proposals/${reviewed.id}/approve`,
      headers: headers(userA),
      payload: {},
    });
    expect(approved.statusCode).toBe(200);
    expect(await database.mandateCredential.count({ where: { proposalId: reviewed.id } })).toBe(2);
  });

  it("creates the PayPal order for the signed cart and refuses a tampered cart", async () => {
    const mandate = await createMandate(userA, "ACTIVE", "enforce");
    const honest = await createProposal(userA, mandate, 13_900n, "honest");
    await evaluate(userA, honest.id);
    const ok = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: honest.id },
    });
    expect(ok.statusCode).toBe(200);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder.mock.calls[0]![0].amountMinor).toBe(13_900);

    // Hidden-line-item style tampering after authorization: an extra charge is
    // added to the stored cart. The signed cart mandate no longer matches.
    const tampered = await createProposal(userA, mandate, 13_900n, "tampered");
    await evaluate(userA, tampered.id);
    await database.purchaseProposal.update({
      where: { id: tampered.id },
      data: { shipping: 4_900n, total: 18_800n },
    });
    createOrder.mockClear();
    const refused = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: tampered.id },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "CART_MANDATE_MISMATCH" });
    expect(createOrder).not.toHaveBeenCalled();
    expect(await database.payment.count({ where: { proposalId: tampered.id } })).toBe(0);
    const audit = await database.auditEvent.findFirst({
      where: { eventType: AuditEventType.CART_MANDATE_MISMATCH, entityId: tampered.id },
    });
    expect(audit?.payload).toMatchObject({ reason: "CART_HASH_MISMATCH", paypalCalled: false });
    const readback = (await proposalCredentials(userA, tampered.id)).json() as {
      hashVerified: boolean;
    };
    expect(readback.hashVerified).toBe(false);

    // Swapping the product for another one at the same price is caught too.
    const swapped = await createProposal(userA, mandate, 13_900n, "swapped");
    await evaluate(userA, swapped.id);
    const other = await createProposal(userA, mandate, 13_900n, "swap-target");
    await database.purchaseProposal.update({
      where: { id: swapped.id },
      data: { productSnapshotId: other.productSnapshotId },
    });
    const swapRefused = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: swapped.id },
    });
    expect(swapRefused.statusCode).toBe(409);
    expect(swapRefused.json()).toMatchObject({ code: "CART_MANDATE_MISMATCH" });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("lazily issues a missing cart mandate once before creating the order", async () => {
    const mandate = await createMandate(userA, "ACTIVE", "missing");
    const proposal = await createProposal(userA, mandate, 13_900n, "missing");
    // Authorized without the after-commit hook (as an admin re-evaluation would be).
    await database.$transaction((tx) =>
      evaluateProposalInTransaction(tx, { id: userA }, proposal.id),
    );
    expect(await database.mandateCredential.count({ where: { proposalId: proposal.id } })).toBe(0);
    const response = await app.inject({
      method: "POST",
      url: "/api/paypal/orders",
      headers: headers(userA),
      payload: { proposalId: proposal.id },
    });
    expect(response.statusCode).toBe(200);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(await database.mandateCredential.count({ where: { proposalId: proposal.id } })).toBe(2);
  });

  it("verifies credentials publicly with the JWKS only", async () => {
    const jwks = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    expect(jwks.statusCode).toBe(200);
    expect(jwks.headers["cache-control"]).toContain("public");
    const keys = (jwks.json() as { keys: Array<Record<string, unknown>> }).keys;
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys.every((key) => key.d === undefined && key.alg === "ES256")).toBe(true);
    const alias = await app.inject({ method: "GET", url: "/api/credentials/jwks" });
    expect(alias.json()).toEqual(jwks.json());

    const mandate = await createMandate(userA, "ACTIVE", "verify");
    const proposal = await createProposal(userA, mandate, 13_900n, "verify");
    await evaluate(userA, proposal.id);
    const credentials = (await proposalCredentials(userA, proposal.id)).json() as {
      credentials: Array<{ kind: string; jwt: string; kid: string }>;
    };
    const checkout = credentials.credentials.find((item) => item.kind === "CLOSED_CHECKOUT")!;
    expect(keys.map((key) => key.kid)).toContain(checkout.kid);

    // No session: verification is public.
    const valid = await app.inject({
      method: "POST",
      url: "/api/credentials/verify",
      headers: { "content-type": "application/json" },
      payload: { credential: checkout.jwt },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({
      valid: true,
      kind: "CLOSED_CHECKOUT",
      kid: checkout.kid,
      reason: null,
      claims: { proposalId: proposal.id, vct: "mandate.checkout.1" },
    });

    const [header, payload, signature] = checkout.jwt.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as {
      mandatepay_checkout: { total: number };
    };
    decoded.mandatepay_checkout.total = 1;
    const forged = `${header}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;
    const invalid = await app.inject({
      method: "POST",
      url: "/api/credentials/verify",
      headers: { "content-type": "text/plain" },
      payload: forged,
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toMatchObject({ valid: false, reason: "SIGNATURE_INVALID" });

    const malformed = await app.inject({
      method: "POST",
      url: "/api/credentials/verify",
      headers: { "content-type": "application/json" },
      payload: { credential: "", extra: true },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("rate-limits public verification", async () => {
    const limited = Fastify({ logger: false });
    registerPublicCredentialRoutes(limited, { verifyMaximum: 2 });
    await limited.ready();
    const codes: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await limited.inject({
        method: "POST",
        url: "/api/credentials/verify",
        headers: { "content-type": "application/json" },
        payload: { credential: "a.b.c" },
      });
      codes.push(response.statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
    await limited.close();
  });
});
