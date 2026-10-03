import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuditEntityType,
  AuditEventType,
  createPrismaClient,
  MandateRepository,
  PaymentStatus,
  ProductCondition,
  ProposalRepository,
  RefundStatus,
} from "@mandatepay/database";
import { registerAnalyticsRoutes } from "./routes/analytics.js";

try {
  process.loadEnvFile?.(fileURLToPath(new URL("../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl)
  throw new Error("TEST_DATABASE_URL is required for analytics integration tests.");
const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//u, ""));
if (!/_test$/u.test(databaseName) || process.env.DATABASE_URL === testDatabaseUrl) {
  throw new Error("Analytics integration tests require an isolated *_test database.");
}

const database = createPrismaClient(testDatabaseUrl);
const app = Fastify({ logger: false });
const origin = process.env.APP_URL ?? "http://localhost:3000";
const runId = randomUUID().slice(0, 12);
const users = new Set<string>();
let userA = "";
let userB = "";
let mandateA = "";
let versionA = "";
let allowProposalId = "";
let blockedProposalId = "";
let ownAuditEntityId = "";
let allowPaymentId = "";
let allowRefundId = "";

function headers(userId: string) {
  return { "x-test-user": userId, origin, "content-type": "application/json" };
}

const canonical = (title: string, now: number) => ({
  title,
  productIntent: "demo office supplies",
  currency: "USD" as const,
  timezone: "UTC" as const,
  allowedBrands: [],
  blockedBrands: [],
  allowedCategories: [],
  blockedCategories: [],
  allowedConditions: ["NEW"] as ["NEW"],
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
});

async function createProposal(key: string, price: bigint) {
  const product = await database.productSnapshot.create({
    data: {
      source: "analytics-test",
      externalId: `analytics-product-${runId}-${key}`,
      title: `Analytics ${key}`,
      brand: "Demo Brand",
      category: "Office",
      condition: ProductCondition.NEW,
      price,
      currency: "USD",
      merchant: "Analytics Merchant",
      metadata: { key },
    },
  });
  return new ProposalRepository(database).create({
    userId: userA,
    mandateId: mandateA,
    mandateVersionId: versionA,
    productSnapshotId: product.id,
    quantity: 1,
    shipping: 0n,
    tax: 0n,
    idempotencyKey: `analytics-proposal-${runId}-${key}`,
  });
}

describe("owned audit and dashboard analytics", () => {
  beforeAll(async () => {
    const first = await database.user.create({
      data: {
        email: `analytics-a-${runId}@mandatepay.local`,
        name: "Analytics A",
        globalAutonomousPurchasingEnabled: true,
      },
    });
    const second = await database.user.create({
      data: {
        email: `analytics-b-${runId}@mandatepay.local`,
        name: "Analytics B",
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
      title: "Analytics mandate",
      originalPrompt: "Keep office spending bounded.",
      autoSpendLimit: 20_000n,
      transactionLimit: 20_000n,
      dailyLimit: 100_000n,
      weeklyLimit: 100_000n,
      monthlyLimit: 100_000n,
      startsAt: new Date(now - 60_000),
      expiresAt: new Date(now + 86_400_000),
      status: "ACTIVE",
      canonicalRules: canonical("Analytics mandate", now),
    });
    mandateA = mandate.id;
    versionA = mandate.activeVersionId ?? "";

    const allow = await createProposal("allow", 10_000n);
    allowProposalId = allow.id;
    await database.$transaction(async (tx) => {
      await tx.policyDecision.create({
        data: {
          proposalId: allow.id,
          mandateVersionId: versionA,
          decision: "ALLOW",
          reasonCodes: [],
          rulesSnapshot: canonical("Analytics mandate", now),
          spendSnapshot: {},
        },
      });
      await tx.purchaseProposal.update({ where: { id: allow.id }, data: { status: "AUTHORIZED" } });
      const reservation = await tx.spendReservation.create({
        data: {
          mandateId: mandateA,
          mandateVersionId: versionA,
          proposalId: allow.id,
          amount: 10_000n,
          currency: "USD",
          window: "TRANSACTION",
          windowStart: new Date(now - 60_000),
          windowEnd: new Date(now + 86_400_000),
          expiresAt: new Date(now + 86_400_000),
          status: "CONSUMED",
          consumedAt: new Date("2026-10-02T12:00:00Z"),
        },
      });
      const createdPayment = await tx.payment.create({
        data: {
          userId: userA,
          mandateId: mandateA,
          proposalId: allow.id,
          paypalCaptureId: `analytics-capture-${runId}`,
          amount: 10_000n,
          currency: "USD",
          status: PaymentStatus.PARTIALLY_REFUNDED,
          idempotencyKey: `analytics-payment-${runId}`,
          capturedAt: new Date("2026-10-02T12:00:00Z"),
        },
      });
      const createdRefund = await tx.refund.create({
        data: {
          paymentId: createdPayment.id,
          userId: userA,
          amount: 2_500n,
          currency: "USD",
          status: RefundStatus.COMPLETED,
          idempotencyKey: `analytics-refund-${runId}`,
          settledAt: new Date("2026-10-02T12:05:00Z"),
        },
      });
      allowPaymentId = createdPayment.id;
      allowRefundId = createdRefund.id;
      await tx.purchaseProposal.update({ where: { id: allow.id }, data: { status: "COMPLETED" } });
      void reservation;
    });
    await database.auditEvent.createMany({
      data: [
        {
          userId: userA,
          eventType: AuditEventType.PAYPAL_ORDER_CREATED,
          entityType: AuditEntityType.PAYMENT,
          entityId: allowPaymentId,
          payload: { paymentId: allowPaymentId, proposalId: allow.id, amountMinor: 10_000 },
        },
        {
          userId: userA,
          eventType: AuditEventType.PURCHASE_PROPOSAL_CREATED,
          entityType: AuditEntityType.PURCHASE_PROPOSAL,
          entityId: allow.id,
          payload: { proposalId: allow.id, mandateId: mandateA },
        },
        {
          userId: userA,
          eventType: AuditEventType.MANDATE_UPDATED,
          entityType: AuditEntityType.MANDATE,
          entityId: mandateA,
          payload: { mandateId: mandateA, version: 1 },
        },
        {
          userId: userA,
          eventType: AuditEventType.REFUND_COMPLETED,
          entityType: AuditEntityType.REFUND,
          entityId: allowRefundId,
          payload: { refundId: allowRefundId, amountMinor: 2_500 },
        },
      ],
    });
    await database.approval.create({
      data: {
        proposalId: allow.id,
        userId: userA,
        decision: "APPROVED",
        proposalFingerprint: allow.proposalFingerprint,
        expiresAt: new Date(now + 60_000),
        decidedAt: new Date("2026-10-02T12:01:00Z"),
      },
    });

    const blocked = await createProposal("blocked", 22_000n);
    blockedProposalId = blocked.id;
    await database.$transaction(async (tx) => {
      const facts = { rulesSnapshot: canonical("Analytics mandate", now), spendSnapshot: {} };
      await tx.policyDecision.create({
        data: {
          proposalId: blocked.id,
          mandateVersionId: versionA,
          decision: "ALLOW",
          reasonCodes: [],
          ...facts,
          createdAt: new Date("2026-10-02T12:02:00Z"),
        },
      });
      await tx.policyDecision.create({
        data: {
          proposalId: blocked.id,
          mandateVersionId: versionA,
          decision: "BLOCK",
          reasonCodes: ["TRANSACTION_LIMIT_EXCEEDED"],
          ...facts,
          createdAt: new Date("2026-10-02T12:03:00Z"),
        },
      });
    });

    const sample = await createProposal("sample", 99_999n);
    await database.purchaseProposal.update({ where: { id: sample.id }, data: { isSample: true } });
    await database.auditEvent.create({
      data: {
        userId: userA,
        eventType: AuditEventType.POLICY_BLOCKED,
        entityType: AuditEntityType.PURCHASE_PROPOSAL,
        entityId: blocked.id,
        payload: { reasonCodes: ["TRANSACTION_LIMIT_EXCEEDED"], password: "should-not-leak" },
      },
    });
    ownAuditEntityId = blocked.id;
    await database.auditEvent.create({
      data: {
        userId: userB,
        eventType: AuditEventType.POLICY_BLOCKED,
        entityType: AuditEntityType.PURCHASE_PROPOSAL,
        entityId: "other-user-event",
        payload: { reasonCodes: ["BRAND_BLOCKED"] },
      },
    });

    registerAnalyticsRoutes(app, {
      database,
      requireUser: async (request, reply) => {
        const id = request.headers["x-test-user"];
        if (typeof id !== "string" || !users.has(id)) {
          await reply.status(401).send({ error: "Unauthorized" });
          return null;
        }
        return { id };
      },
      isTrustedOrigin: (requestOrigin) => requestOrigin === origin,
      parseQuery: async ({ query }) => {
        if (query === "above100") {
          return {
            status: "ready",
            filters: {
              minimumAmountMinor: 10_000,
              minimumAmountOperator: "gt",
              maximumAmountMinor: null,
              maximumAmountOperator: null,
              decision: null,
              since: null,
              until: null,
              category: null,
              chart: "table",
            },
          };
        }
        return {
          status: "needs_clarification",
          clarification: "Use a supported dashboard query.",
          filters: null,
        };
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it("derives owned totals from confirmed records and excludes samples", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
      headers: headers(userA),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().totals).toEqual({
      purchases: 1,
      policyAllowed: 1,
      humanApproved: 1,
      blocked: 1,
      spendMinor: 10_000,
      refundsMinor: 2_500,
      activeMandates: 1,
    });
    const other = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
      headers: headers(userB),
    });
    expect(other.json().totals).toEqual({
      purchases: 0,
      policyAllowed: 0,
      humanApproved: 0,
      blocked: 0,
      spendMinor: 0,
      refundsMinor: 0,
      activeMandates: 0,
    });
  });

  it("deduplicates latest policy decisions and applies strict transaction filters", async () => {
    const blocked = await app.inject({
      method: "GET",
      url: "/api/dashboard/transactions?decision=BLOCK&category=Office&limit=1",
      headers: headers(userA),
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json().transactions).toHaveLength(1);
    expect(blocked.json().transactions[0].id).toBe(blockedProposalId);
    const amount = await app.inject({
      method: "GET",
      url: "/api/dashboard/transactions?minAmountMinor=10000&maxAmountMinor=10000",
      headers: headers(userA),
    });
    expect(amount.statusCode).toBe(200);
    expect(amount.json().transactions.map((row: { id: string }) => row.id)).toContain(
      allowProposalId,
    );
    const invalid = await app.inject({
      method: "GET",
      url: "/api/dashboard/transactions?unknown=1",
      headers: headers(userA),
    });
    expect(invalid.statusCode).toBe(400);
    const page = await app.inject({
      method: "GET",
      url: "/api/dashboard/transactions?limit=1",
      headers: headers(userA),
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().nextCursor).toBeTruthy();
  });

  it("keeps audit and policy events owned and redacts sensitive payload keys", async () => {
    const audit = await app.inject({
      method: "GET",
      url: `/api/audit?entityId=${ownAuditEntityId}`,
      headers: headers(userA),
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().events).toHaveLength(1);
    expect(audit.json().events[0].payload.password).toBeUndefined();
    const otherAudit = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: headers(userB),
    });
    expect(otherAudit.json().events).toHaveLength(1);
    const policy = await app.inject({
      method: "GET",
      url: "/api/dashboard/policy-events",
      headers: headers(userA),
    });
    expect(policy.statusCode).toBe(200);
    expect(policy.json().events).toHaveLength(1);
    expect(policy.json().events[0].reasonCodes).toContain("TRANSACTION_LIMIT_EXCEEDED");
  });

  it("reconstructs the owned payment audit chain from a payment entity id", async () => {
    const audit = await app.inject({
      method: "GET",
      url: `/api/audit?entityId=${allowPaymentId}`,
      headers: headers(userA),
    });
    expect(audit.statusCode).toBe(200);
    const entityIds = new Set(
      (audit.json().events as Array<{ entityId: string }>).map((event) => event.entityId),
    );
    expect(entityIds.has(allowPaymentId)).toBe(true);
    expect(entityIds.has(allowProposalId)).toBe(true);
    expect(entityIds.has(mandateA)).toBe(true);
    expect(entityIds.has(allowRefundId)).toBe(true);
  });

  it("validates natural-language filter output and preserves exclusive amounts", async () => {
    const query = await app.inject({
      method: "POST",
      url: "/api/dashboard/query",
      headers: headers(userA),
      payload: { query: "above100" },
    });
    expect(query.statusCode).toBe(200);
    expect(query.json().status).toBe("ready");
    expect(query.json().transactions).toHaveLength(1);
    const clarification = await app.inject({
      method: "POST",
      url: "/api/dashboard/query",
      headers: headers(userA),
      payload: { query: "unclear" },
    });
    expect(clarification.statusCode).toBe(200);
    expect(clarification.json().status).toBe("needs_clarification");
  });

  it("paginates beyond the old bounded window with a stable activity cursor", async () => {
    const count = 505;
    const products = Array.from({ length: count }, (_, index) => ({
      source: "analytics-bulk",
      externalId: `analytics-bulk-${runId}-${index}`,
      title: `Bulk ${index}`,
      brand: "Bulk Brand",
      category: "Bulk",
      condition: ProductCondition.NEW,
      price: 1_000n,
      currency: "USD",
      merchant: "Bulk Merchant",
      metadata: { index },
    }));
    await database.productSnapshot.createMany({ data: products });
    const snapshots = await database.productSnapshot.findMany({
      where: { source: "analytics-bulk", externalId: { startsWith: `analytics-bulk-${runId}-` } },
      select: { id: true },
      orderBy: { externalId: "asc" },
    });
    await database.purchaseProposal.createMany({
      data: snapshots.map((snapshot, index) => ({
        userId: userA,
        mandateId: mandateA,
        mandateVersionId: versionA,
        productSnapshotId: snapshot.id,
        quantity: 1,
        subtotal: 1_000n,
        shipping: 0n,
        tax: 0n,
        total: 1_000n,
        currency: "USD",
        status: "PROPOSED",
        proposalFingerprint: `${runId}${index}`.padEnd(64, "0"),
        idempotencyKey: `analytics-bulk-proposal-${runId}-${index}`,
      })),
    });

    let cursor: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      const query = new URLSearchParams({ category: "Bulk", limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const page = await app.inject({
        method: "GET",
        url: `/api/dashboard/transactions?${query.toString()}`,
        headers: headers(userA),
      });
      expect(page.statusCode).toBe(200);
      for (const row of page.json().transactions as Array<{ id: string }>) seen.add(row.id);
      cursor = page.json().nextCursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(count);
  });

  it("enforces the per-user natural-language query budget", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/dashboard/query",
        headers: headers(userB),
        payload: { query: "above100" },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});
