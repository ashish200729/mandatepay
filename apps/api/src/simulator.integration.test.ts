import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createPrismaClient,
  MandateRepository,
  ProductCondition,
  ProposalRepository,
  ReservationStatus,
} from "@mandatepay/database";
import { registerSimulatorRoutes } from "./routes/simulator.js";
import { evaluateProposal } from "./services/proposals.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl)
  throw new Error("TEST_DATABASE_URL is required for simulator integration tests.");
const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//u, ""));
if (!/_test$/u.test(databaseName) || process.env.DATABASE_URL === testDatabaseUrl) {
  throw new Error("Simulator integration tests require an isolated *_test database.");
}

const database = createPrismaClient(testDatabaseUrl);
const app = Fastify({ logger: false });
const origin = process.env.APP_URL ?? "http://localhost:3000";
const users = new Set<string>();
const testRunId = randomUUID().slice(0, 12);
let owner = "";
let stranger = "";
let mandateId = "";

const demoRules = (now: number) => ({
  title: "Simulator demo mandate",
  productIntent: "Sony or Bose noise-cancelling headphones",
  currency: "USD" as const,
  timezone: "UTC" as const,
  allowedBrands: ["Sony", "Bose"],
  blockedBrands: [],
  allowedCategories: ["Headphones"],
  blockedCategories: [],
  allowedConditions: ["NEW" as const],
  autoSpendLimit: 15_000,
  transactionLimit: 18_000,
  dailyLimit: 1_000_000,
  weeklyLimit: 1_000_000,
  monthlyLimit: 1_000_000,
  quantityLimit: 1,
  allowedMerchants: [],
  blockedMerchants: [],
  newMerchantRequiresApproval: false,
  startsAt: new Date(now - 60_000).toISOString(),
  expiresAt: new Date(now + 86_400_000).toISOString(),
});

function headers(userId: string) {
  return { "x-test-user": userId, origin, "content-type": "application/json" };
}

function product(price: number, overrides: Record<string, unknown> = {}) {
  return {
    price,
    quantity: 1,
    condition: "NEW",
    brand: "Sony",
    category: "Headphones",
    merchant: "Mandate Demo Store",
    ...overrides,
  };
}

async function simulate(payload: unknown, userId = owner, id = mandateId) {
  return app.inject({
    method: "POST",
    url: `/api/mandates/${id}/simulate`,
    headers: headers(userId),
    payload: payload as object,
  });
}

/** Every row a real evaluation could create or change for this user and mandate. */
async function footprint(forMandate = mandateId) {
  const [proposals, decisions, reservations, approvals, audits, mandate] = await Promise.all([
    database.purchaseProposal.count({ where: { userId: owner } }),
    database.policyDecision.count({ where: { proposal: { userId: owner } } }),
    database.spendReservation.findMany({
      where: { mandateId: forMandate },
      select: { id: true, status: true, releasedAt: true },
      orderBy: { id: "asc" },
    }),
    database.approval.count({ where: { userId: owner } }),
    database.auditEvent.count({ where: { userId: owner } }),
    database.mandate.findUniqueOrThrow({
      where: { id: forMandate },
      select: { status: true, version: true, updatedAt: true },
    }),
  ]);
  return { proposals, decisions, reservations, approvals, audits, mandate };
}

describe("AgentGuard policy simulator (database)", () => {
  beforeAll(async () => {
    const first = await database.user.create({
      data: {
        email: `simulator-a-${testRunId}@mandatepay.local`,
        name: "Simulator A",
        globalAutonomousPurchasingEnabled: true,
      },
    });
    const second = await database.user.create({
      data: {
        email: `simulator-b-${testRunId}@mandatepay.local`,
        name: "Simulator B",
        globalAutonomousPurchasingEnabled: true,
      },
    });
    owner = first.id;
    stranger = second.id;
    users.add(owner);
    users.add(stranger);
    const now = Date.now();
    const mandate = await new MandateRepository(database).create({
      userId: owner,
      title: "Simulator demo mandate",
      originalPrompt: "Buy Sony or Bose headphones, new only, automatically up to $150.",
      autoSpendLimit: 15_000n,
      transactionLimit: 18_000n,
      dailyLimit: 1_000_000n,
      weeklyLimit: 1_000_000n,
      monthlyLimit: 1_000_000n,
      startsAt: new Date(now - 60_000),
      expiresAt: new Date(now + 86_400_000),
      status: "ACTIVE",
      canonicalRules: demoRules(now),
    });
    mandateId = mandate.id;

    registerSimulatorRoutes(app, {
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
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it("returns ALLOW, REQUIRE_APPROVAL and BLOCK at the demo thresholds without writing", async () => {
    const before = await footprint();
    const allow = await simulate(product(13_900));
    expect(allow.statusCode, allow.body).toBe(200);
    expect(allow.json()).toMatchObject({ simulated: true, decision: "ALLOW", reasonCodes: [] });

    const approval = await simulate(product(16_900));
    expect(approval.json()).toMatchObject({
      decision: "REQUIRE_APPROVAL",
      reasonCodes: ["AUTO_SPEND_THRESHOLD_EXCEEDED"],
    });
    expect(approval.json().explanation.approvalCanOverride).toBe(true);

    const block = await simulate(
      product(22_000, { brand: "Sony", merchant: "Mandate Demo Store" }),
    );
    expect(block.json()).toMatchObject({
      decision: "BLOCK",
      reasonCodes: ["TRANSACTION_LIMIT_EXCEEDED"],
    });
    expect(block.json().explanation.approvalCanOverride).toBe(false);

    const refurbished = await simulate(
      product(12_000, { brand: "Bose", condition: "REFURBISHED" }),
    );
    expect(refurbished.json()).toMatchObject({
      decision: "BLOCK",
      reasonCodes: ["CONDITION_NOT_ALLOWED"],
    });

    expect(await footprint()).toEqual(before);
  });

  it("runs in a transaction PostgreSQL itself keeps read-only", async () => {
    await expect(
      database.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.auditEvent.create({
          data: {
            userId: owner,
            eventType: "POLICY_ALLOWED",
            entityType: "PURCHASE_PROPOSAL",
            entityId: `simulator-probe-${testRunId}`,
            payload: {},
          },
        });
      }),
    ).rejects.toThrow();
    expect(
      await database.auditEvent.count({ where: { entityId: `simulator-probe-${testRunId}` } }),
    ).toBe(0);
  });

  it("counts a live hold but never releases an expired one", async () => {
    // Mandate versions are immutable, so the tighter daily limit gets its own mandate:
    // a live $139 hold matters because 139 + 139 > 200.
    const now = Date.now();
    const tight = await new MandateRepository(database).create({
      userId: owner,
      title: "Simulator daily-limit mandate",
      originalPrompt: "Buy Sony or Bose headphones, new only, at most $200 a day.",
      autoSpendLimit: 15_000n,
      transactionLimit: 18_000n,
      dailyLimit: 20_000n,
      weeklyLimit: 1_000_000n,
      monthlyLimit: 1_000_000n,
      startsAt: new Date(now - 60_000),
      expiresAt: new Date(now + 86_400_000),
      status: "ACTIVE",
      canonicalRules: {
        ...demoRules(now),
        title: "Simulator daily-limit mandate",
        dailyLimit: 20_000,
      },
    });
    const snapshot = await database.productSnapshot.create({
      data: {
        source: "demo",
        externalId: `simulator-hold-${testRunId}`,
        title: "Sony WH-1000XM5",
        brand: "Sony",
        category: "Headphones",
        condition: ProductCondition.NEW,
        price: 13_900n,
        currency: "USD",
        merchant: "Mandate Demo Store",
        metadata: { externalId: `simulator-hold-${testRunId}` },
      },
    });
    const proposal = await new ProposalRepository(database).create({
      userId: owner,
      mandateId: tight.id,
      mandateVersionId: tight.activeVersionId ?? "",
      productSnapshotId: snapshot.id,
      quantity: 1,
      shipping: 0n,
      tax: 0n,
      idempotencyKey: `simulator-hold-${testRunId}`,
    });
    const evaluated = await evaluateProposal(database, { id: owner }, proposal.id);
    expect(evaluated.decision.decision).toBe("ALLOW");
    const reservation = await database.spendReservation.findUniqueOrThrow({
      where: { proposalId: proposal.id },
    });
    expect(reservation.status).toBe(ReservationStatus.ACTIVE);

    const held = await simulate(product(13_900), owner, tight.id);
    expect(held.json()).toMatchObject({ decision: "BLOCK", reasonCodes: ["DAILY_LIMIT_EXCEEDED"] });

    // An expired unpaid hold is ignored by the simulation and left untouched.
    await database.spendReservation.update({
      where: { id: reservation.id },
      data: { expiresAt: new Date(now - 1_000) },
    });
    const before = await footprint(tight.id);
    const released = await simulate(product(13_900), owner, tight.id);
    expect(released.json()).toMatchObject({ decision: "ALLOW" });
    expect(await footprint(tight.id)).toEqual(before);
    const after = await database.spendReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(after.status).toBe(ReservationStatus.ACTIVE);
    expect(after.releasedAt).toBeNull();
  });

  it("returns the real hard block for a paused mandate and 404 for another user", async () => {
    await database.mandate.update({ where: { id: mandateId }, data: { status: "PAUSED" } });
    try {
      const paused = await simulate(product(13_900));
      expect(paused.statusCode).toBe(200);
      expect(paused.json()).toMatchObject({ decision: "BLOCK", reasonCodes: ["MANDATE_INACTIVE"] });
    } finally {
      await database.mandate.update({ where: { id: mandateId }, data: { status: "ACTIVE" } });
    }
    const foreign = await simulate(product(13_900), stranger);
    expect(foreign.statusCode).toBe(404);
  });
});
