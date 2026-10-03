import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  MandateStatus,
  MandateRuleType,
  PaymentStatus,
  PolicyDecisionType,
  ProductCondition,
  ProposalStatus,
  ReservationStatus,
  ReservationWindow,
  RuleOperator,
} from "../../src/generated/prisma/enums.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseError } from "../../src/errors.js";
import { AuditRepository } from "../../src/repositories/audit-repository.js";
import { MandateRepository } from "../../src/repositories/mandate-repository.js";
import { ProposalRepository } from "../../src/repositories/proposal-repository.js";
import { SpendRepository } from "../../src/repositories/spend-repository.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error("TEST_DATABASE_URL is required for database integration tests.");
}
const databaseName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//u, ""));
if (!/_test$/u.test(databaseName)) {
  throw new Error("Database integration tests require a database name ending in _test.");
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL === connectionString) {
  throw new Error("Database integration tests cannot use DATABASE_URL.");
}

describe("database phase integration", () => {
  const adapter = new PrismaPg({ connectionString });
  const db = new PrismaClient({ adapter });
  const suffix = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  const userA = "db-test-a-" + suffix + "@mandatepay.local";
  const userB = "db-test-b-" + suffix + "@mandatepay.local";
  let userAId = "";
  let userBId = "";
  let mandateId = "";
  let versionId = "";
  let productId = "";
  let failedProposalId = "";

  beforeAll(async () => {
    const first = await db.user.create({ data: { email: userA, name: "Database test A" } });
    const second = await db.user.create({ data: { email: userB, name: "Database test B" } });
    userAId = first.id;
    userBId = second.id;
    const mandates = new MandateRepository(db);
    const mandate = await mandates.create({
      userId: userAId,
      title: "Concurrency test mandate",
      originalPrompt: "Allow new demo headphones while keeping a two hundred dollar daily cap.",
      status: MandateStatus.ACTIVE,
      autoSpendLimit: 15_000n,
      transactionLimit: 18_000n,
      dailyLimit: 20_000n,
      weeklyLimit: null,
      monthlyLimit: null,
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 86_400_000),
      rules: [
        {
          ruleType: MandateRuleType.ALLOWED_BRAND,
          operator: RuleOperator.IN,
          value: ["Sony"],
        },
      ],
    });
    mandateId = mandate.id;
    versionId = mandate.activeVersionId ?? "";
    const product = await db.productSnapshot.create({
      data: {
        source: "integration-test",
        externalId: "headphones-" + suffix,
        title: "Test headphones",
        brand: "Sony",
        category: "headphones",
        condition: ProductCondition.NEW,
        price: 15_000n,
        currency: "USD",
        merchant: "Test merchant",
        metadata: { test: true },
      },
    });
    productId = product.id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("persists ownership and immutable mandate history", async () => {
    const mandates = new MandateRepository(db);
    await expect(mandates.getByIdForUser(mandateId, userBId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const first = await mandates.getByIdForUser(mandateId, userAId);
    const oldVersionId = first.activeVersionId ?? "";
    await mandates.createVersion(mandateId, userAId, {
      title: "Updated concurrency test mandate",
      originalPrompt: "Updated prompt with the same safety limits.",
      autoSpendLimit: 15_000n,
      transactionLimit: 18_000n,
      dailyLimit: 20_000n,
      weeklyLimit: null,
      monthlyLimit: null,
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 86_400_000),
      rules: [],
    });
    const latest = await mandates.getByIdForUser(mandateId, userAId);
    expect(latest.version).toBe(first.version + 1);
    expect(latest.versions).toHaveLength(2);
    expect(latest.versions[0]?.title).toBe("Updated concurrency test mandate");
    expect(latest.versions.at(-1)?.title).toBe("Concurrency test mandate");
    expect(latest.versions[0]?.canonicalRules).toBeTruthy();
    versionId = latest.activeVersionId ?? "";

    const proposals = new ProposalRepository(db);
    await expect(
      proposals.create({
        userId: userAId,
        mandateId,
        mandateVersionId: oldVersionId,
        productSnapshotId: productId,
        quantity: 1,
        shipping: 0n,
        tax: 0n,
        idempotencyKey: "stale-version-" + suffix,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects direct update and delete attempts against immutable history", async () => {
    const audit = await db.auditEvent.create({
      data: {
        userId: userAId,
        eventType: "PRODUCT_SELECTED",
        entityType: "PRODUCT_SNAPSHOT",
        entityId: productId,
        payload: { productSnapshotId: productId },
      },
    });
    const policyProposal = await db.purchaseProposal.create({
      data: {
        userId: userAId,
        mandateId,
        mandateVersionId: versionId,
        productSnapshotId: productId,
        quantity: 1,
        subtotal: 1_000n,
        shipping: 0n,
        tax: 0n,
        total: 1_000n,
        currency: "USD",
        status: ProposalStatus.PROPOSED,
        proposalFingerprint: "immutable-policy-" + suffix,
        idempotencyKey: "immutable-policy-" + suffix,
      },
    });
    const decision = await db.policyDecision.create({
      data: {
        proposalId: policyProposal.id,
        mandateVersionId: versionId,
        decision: PolicyDecisionType.ALLOW,
        reasonCodes: ["TEST"],
        rulesSnapshot: { test: true },
        spendSnapshot: { test: true },
      },
    });
    const rule = await db.mandateRule.findFirst({ where: { mandateId } });
    const version = await db.mandateVersion.findUnique({ where: { id: versionId } });
    expect(decision).toBeTruthy();
    expect(rule).toBeTruthy();
    expect(version).toBeTruthy();

    await expect(
      db.$executeRawUnsafe(
        'UPDATE "AuditEvent" SET "payload" = $1::jsonb WHERE id = $2',
        JSON.stringify({ changed: true }),
        audit.id,
      ),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe('DELETE FROM "AuditEvent" WHERE id = $1', audit.id),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(
        'UPDATE "PolicyDecision" SET "reasonCodes" = $1::jsonb WHERE id = $2',
        JSON.stringify(["changed"]),
        decision?.id,
      ),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe('DELETE FROM "MandateVersion" WHERE id = $1', version?.id),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe('DELETE FROM "MandateRule" WHERE id = $1', rule?.id),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(
        'UPDATE "ProductSnapshot" SET "title" = $1 WHERE id = $2',
        "changed",
        productId,
      ),
    ).rejects.toThrow();
  });

  it("deduplicates concurrent audit appends and rejects a payload collision", async () => {
    const audits = new AuditRepository(db);
    const payload = { purchaseProposalId: "dedupe-proposal", decision: "ALLOW" };
    const results = await Promise.all([
      audits.append({
        userId: userAId,
        eventType: "POLICY_ALLOWED",
        entityType: "PURCHASE_PROPOSAL",
        entityId: "dedupe-proposal",
        dedupeKey: "integration-dedupe-" + suffix,
        payload,
      }),
      audits.append({
        userId: userAId,
        eventType: "POLICY_ALLOWED",
        entityType: "PURCHASE_PROPOSAL",
        entityId: "dedupe-proposal",
        dedupeKey: "integration-dedupe-" + suffix,
        payload,
      }),
    ]);
    expect(results[0].id).toBe(results[1].id);
    await expect(
      audits.append({
        userId: userAId,
        eventType: "POLICY_BLOCKED",
        entityType: "PURCHASE_PROPOSAL",
        entityId: "dedupe-proposal",
        dedupeKey: "integration-dedupe-" + suffix,
        payload: { purchaseProposalId: "dedupe-proposal", decision: "BLOCK" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      audits.append({
        userId: userAId,
        eventType: "POLICY_ALLOWED",
        entityType: "PURCHASE_PROPOSAL",
        entityId: "sensitive-payload",
        payload: { password: "must-not-be-recorded" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOMAIN_INPUT" });
  });

  it("persists server-computed proposal totals and enforces ownership", async () => {
    const proposals = new ProposalRepository(db);
    const proposal = await proposals.create({
      userId: userAId,
      mandateId,
      mandateVersionId: versionId,
      productSnapshotId: productId,
      quantity: 1,
      shipping: 0n,
      tax: 0n,
      idempotencyKey: "proposal-a-" + suffix,
    });
    expect(proposal.subtotal).toBe(15_000n);
    expect(proposal.total).toBe(15_000n);
    await expect(proposals.getByIdForUser(proposal.id, userBId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await proposals.recordPolicyDecision({
      proposalId: proposal.id,
      userId: userAId,
      decision: PolicyDecisionType.ALLOW,
      reasonCodes: ["WITHIN_AUTONOMOUS_LIMIT"],
      rulesSnapshot: { autoSpendLimit: "15000" },
      spendSnapshot: { dailySpend: "0" },
    });
    const persisted = await proposals.getByIdForUser(proposal.id, userAId);
    expect(persisted.status).toBe(ProposalStatus.AUTHORIZED);

    const mandates = new MandateRepository(db);
    await mandates.pause(mandateId, userAId);
    const spend = new SpendRepository(db);
    await expect(
      spend.reserve({
        userId: userAId,
        mandateId,
        mandateVersionId: versionId,
        proposalId: proposal.id,
        amount: 15_000n,
        currency: "USD",
        window: ReservationWindow.DAILY,
        windowStart: new Date(Date.now() - 1_000),
        windowEnd: new Date(Date.now() + 86_400_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await mandates.resume(mandateId, userAId);
    await expect(
      spend.reserve({
        userId: userAId,
        mandateId,
        mandateVersionId: versionId,
        proposalId: proposal.id,
        amount: 15_000n,
        currency: "EUR",
        window: ReservationWindow.DAILY,
        windowStart: new Date(Date.now() - 1_000),
        windowEnd: new Date(Date.now() + 86_400_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CURRENCY" });
  });

  it("allows exactly one of two concurrent 150 dollar reservations under a 200 dollar cap", async () => {
    const proposals = new ProposalRepository(db);
    const proposal = await proposals.create({
      userId: userAId,
      mandateId,
      mandateVersionId: versionId,
      productSnapshotId: productId,
      quantity: 1,
      shipping: 0n,
      tax: 0n,
      idempotencyKey: "proposal-b-" + suffix,
    });
    await proposals.recordPolicyDecision({
      proposalId: proposal.id,
      userId: userAId,
      decision: PolicyDecisionType.ALLOW,
      reasonCodes: ["WITHIN_AUTONOMOUS_LIMIT"],
      rulesSnapshot: { autoSpendLimit: "15000" },
      spendSnapshot: { dailySpend: "0" },
    });

    const secondProduct = await db.productSnapshot.create({
      data: {
        source: "integration-test",
        externalId: "headphones-second-" + suffix,
        title: "Second test headphones",
        brand: "Sony",
        category: "headphones",
        condition: ProductCondition.NEW,
        price: 15_000n,
        currency: "USD",
        merchant: "Test merchant",
        metadata: { test: true },
      },
    });
    const second = await proposals.create({
      userId: userAId,
      mandateId,
      mandateVersionId: versionId,
      productSnapshotId: secondProduct.id,
      quantity: 1,
      shipping: 0n,
      tax: 0n,
      idempotencyKey: "proposal-c-" + suffix,
    });
    failedProposalId = second.id;
    await proposals.recordPolicyDecision({
      proposalId: second.id,
      userId: userAId,
      decision: PolicyDecisionType.ALLOW,
      reasonCodes: ["WITHIN_AUTONOMOUS_LIMIT"],
      rulesSnapshot: { autoSpendLimit: "15000" },
      spendSnapshot: { dailySpend: "0" },
    });

    const spend = new SpendRepository(db);
    const windowStart = new Date();
    const windowEnd = new Date(windowStart.getTime() + 86_400_000);
    const expiresAt = new Date(windowStart.getTime() + 3_600_000);
    const reserve = (proposalId: string) =>
      spend.reserve({
        userId: userAId,
        mandateId,
        mandateVersionId: versionId,
        proposalId,
        amount: 15_000n,
        currency: "USD",
        window: ReservationWindow.DAILY,
        windowStart,
        windowEnd,
        expiresAt,
      });
    const results = await Promise.allSettled([reserve(proposal.id), reserve(second.id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(DatabaseError);
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe("LIMIT_EXCEEDED");
    expect(
      await db.spendReservation.count({ where: { mandateId, status: ReservationStatus.ACTIVE } }),
    ).toBe(1);

    const winner = results.find((result) => result.status === "fulfilled");
    expect(winner).toBeDefined();
    const winnerId = winner?.status === "fulfilled" ? winner.value.proposalId : proposal.id;
    const reevaluated = await spend.reserve({
      userId: userAId,
      mandateId,
      mandateVersionId: versionId,
      proposalId: winnerId,
      amount: 15_000n,
      currency: "USD",
      window: ReservationWindow.DAILY,
      windowStart,
      windowEnd,
      expiresAt,
    });
    expect(reevaluated.proposalId).toBe(winnerId);
    expect(
      await db.spendReservation.count({ where: { mandateId, status: ReservationStatus.ACTIVE } }),
    ).toBe(1);
  });

  it("rolls back reservation-side expiration when proposal validation fails", async () => {
    const oldProposal = await db.purchaseProposal.create({
      data: {
        id: "rollback-proposal-" + suffix,
        userId: userAId,
        mandateId,
        mandateVersionId: versionId,
        productSnapshotId: productId,
        quantity: 1,
        subtotal: 1_000n,
        shipping: 0n,
        tax: 0n,
        total: 1_000n,
        currency: "USD",
        status: ProposalStatus.BLOCKED,
        proposalFingerprint: "rollback-fingerprint-" + suffix,
        idempotencyKey: "rollback-idempotency-" + suffix,
      },
    });
    const stale = await db.spendReservation.create({
      data: {
        mandateId,
        mandateVersionId: versionId,
        proposalId: oldProposal.id,
        amount: 1_000n,
        currency: "USD",
        window: ReservationWindow.DAILY,
        windowStart: new Date(Date.now() - 86_400_000),
        windowEnd: new Date(Date.now() + 86_400_000),
        status: ReservationStatus.ACTIVE,
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const inflightProposal = await db.purchaseProposal.create({
      data: {
        id: "inflight-proposal-" + suffix,
        userId: userAId,
        mandateId,
        mandateVersionId: versionId,
        productSnapshotId: productId,
        quantity: 1,
        subtotal: 1_000n,
        shipping: 0n,
        tax: 0n,
        total: 1_000n,
        currency: "USD",
        status: ProposalStatus.PAYMENT_PENDING,
        proposalFingerprint: "inflight-fingerprint-" + suffix,
        idempotencyKey: "inflight-idempotency-" + suffix,
      },
    });
    await db.payment.create({
      data: {
        userId: userAId,
        mandateId,
        proposalId: inflightProposal.id,
        amount: 1_000n,
        currency: "USD",
        status: PaymentStatus.CAPTURE_PENDING,
        idempotencyKey: "inflight-payment-" + suffix,
      },
    });
    const inflightReservation = await db.spendReservation.create({
      data: {
        mandateId,
        mandateVersionId: versionId,
        proposalId: inflightProposal.id,
        amount: 1_000n,
        currency: "USD",
        window: ReservationWindow.DAILY,
        windowStart: new Date(Date.now() - 86_400_000),
        windowEnd: new Date(Date.now() + 86_400_000),
        status: ReservationStatus.ACTIVE,
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const spend = new SpendRepository(db);
    await db.purchaseProposal.update({
      where: { id: failedProposalId },
      data: { status: ProposalStatus.BLOCKED },
    });
    await expect(
      spend.reserve({
        userId: userAId,
        mandateId,
        mandateVersionId: versionId,
        proposalId: failedProposalId,
        amount: 15_000n,
        currency: "USD",
        window: ReservationWindow.DAILY,
        windowStart: new Date(),
        windowEnd: new Date(Date.now() + 86_400_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    const after = await db.spendReservation.findUnique({ where: { id: stale.id } });
    expect(after?.status).toBe(ReservationStatus.ACTIVE);
    const inflightAfter = await db.spendReservation.findUnique({
      where: { id: inflightReservation.id },
    });
    expect(inflightAfter?.status).toBe(ReservationStatus.ACTIVE);
    await db.spendReservation.delete({ where: { id: stale.id } });
    await db.purchaseProposal.delete({ where: { id: oldProposal.id } });
  });
});
