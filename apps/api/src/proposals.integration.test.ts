import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, MandateRepository, ProposalRepository } from "@mandatepay/database";
import { ProductCondition } from "@mandatepay/database";
import { registerProposalRoutes } from "./routes/proposals.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl)
  throw new Error("TEST_DATABASE_URL is required for proposal integration tests.");
const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//u, ""));
if (!/_test$/u.test(databaseName) || process.env.DATABASE_URL === testDatabaseUrl) {
  throw new Error("Proposal integration tests require an isolated *_test database.");
}

const database = createPrismaClient(testDatabaseUrl);
const app = Fastify({ logger: false });
const origin = process.env.APP_URL ?? "http://localhost:3000";
const users = new Set<string>();
let userA = "";
let userB = "";
let mandateA = "";
let mandateB = "";
let versionA = "";
let versionB = "";
const products = new Map<string, string>();
const proposals = new ProposalRepository(database);

function headers(userId: string) {
  return { "x-test-user": userId, origin, "content-type": "application/json" };
}

async function createProposal(
  userId: string,
  mandateId: string,
  mandateVersionId: string,
  productSnapshotId: string,
) {
  return proposals.create({
    userId,
    mandateId,
    mandateVersionId,
    productSnapshotId,
    quantity: 1,
    shipping: 0n,
    tax: 0n,
    idempotencyKey: "proposal-" + Date.now() + "-" + Math.random().toString(36).slice(2),
  });
}

describe("AgentGuard proposal service", () => {
  beforeAll(async () => {
    const first = await database.user.create({
      data: { email: "proposal-a-" + Date.now() + "@mandatepay.local", name: "Proposal A" },
    });
    const second = await database.user.create({
      data: { email: "proposal-b-" + Date.now() + "@mandatepay.local", name: "Proposal B" },
    });
    userA = first.id;
    userB = second.id;
    users.add(userA);
    users.add(userB);
    await database.user.update({
      where: { id: userA },
      data: { globalAutonomousPurchasingEnabled: true },
    });
    await database.user.update({
      where: { id: userB },
      data: { globalAutonomousPurchasingEnabled: true },
    });
    const mandates = new MandateRepository(database);
    const base = {
      title: "Proposal headphones",
      originalPrompt: "Buy new headphones under control.",
      autoSpendLimit: 15_000n,
      transactionLimit: 18_000n,
      dailyLimit: 20_000n,
      weeklyLimit: 50_000n,
      monthlyLimit: 100_000n,
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 86_400_000),
      rules: [],
    } as const;
    const firstMandate = await mandates.create({
      ...base,
      dailyLimit: 100_000n,
      userId: userA,
      status: "ACTIVE",
    });
    const secondMandate = await mandates.create({ ...base, userId: userB, status: "ACTIVE" });
    mandateA = firstMandate.id;
    mandateB = secondMandate.id;
    versionA = firstMandate.activeVersionId ?? "";
    versionB = secondMandate.activeVersionId ?? "";
    for (const price of [13_900n, 16_900n, 22_000n, 15_000n]) {
      const product = await database.productSnapshot.create({
        data: {
          source: "proposal-integration",
          externalId: "headphones-" + price.toString() + "-" + Date.now(),
          title: "Test headphones " + price.toString(),
          brand: "Sony",
          category: "headphones",
          condition: ProductCondition.NEW,
          price,
          currency: "USD",
          merchant: "Proposal Test Merchant",
          metadata: { test: true },
        },
      });
      products.set(price.toString(), product.id);
    }
    registerProposalRoutes(app, {
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

  it("persists proposals and returns ALLOW, REQUIRE_APPROVAL, and BLOCK", async () => {
    const allow = await createProposal(userA, mandateA, versionA, products.get("13900")!);
    const allowDecision = await app.inject({
      method: "POST",
      url: "/api/proposals/" + allow.id + "/evaluate",
      headers: headers(userA),
      payload: {},
    });
    expect(allowDecision.statusCode).toBe(200);
    expect(allowDecision.json().decision.decision).toBe("ALLOW");

    const approval = await createProposal(userA, mandateA, versionA, products.get("16900")!);
    const approvalDecision = await app.inject({
      method: "POST",
      url: "/api/proposals/" + approval.id + "/evaluate",
      headers: headers(userA),
      payload: {},
    });
    expect(approvalDecision.statusCode).toBe(200);
    expect(approvalDecision.json().decision.decision).toBe("REQUIRE_APPROVAL");
    const approvalBeforeRetry = await database.approval.findUnique({
      where: { proposalId: approval.id },
    });
    const retryEvaluation = await app.inject({
      method: "POST",
      url: "/api/proposals/" + approval.id + "/evaluate",
      headers: headers(userA),
      payload: {},
    });
    expect(retryEvaluation.statusCode).toBe(200);
    const approvalAfterRetry = await database.approval.findUnique({
      where: { proposalId: approval.id },
    });
    expect(approvalAfterRetry?.expiresAt).toEqual(approvalBeforeRetry?.expiresAt);
    const approvalInbox = await app.inject({
      method: "GET",
      url: "/api/approvals",
      headers: headers(userA),
    });
    expect(approvalInbox.statusCode).toBe(200);
    expect(approvalInbox.json().proposals[0].product).toMatchObject({
      title: expect.any(String),
      merchant: "Proposal Test Merchant",
    });
    expect(approvalInbox.json().proposals[0]).toMatchObject({
      expiresAt: null,
      approvalExpiresAt: expect.any(String),
      mandate: {
        title: expect.any(String),
        version: expect.any(Number),
      },
    });
    const approved = await app.inject({
      method: "POST",
      url: "/api/proposals/" + approval.id + "/approve",
      headers: headers(userA),
      payload: {},
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().proposal.status).toBe("AUTHORIZED");
    const approvedAgain = await app.inject({
      method: "POST",
      url: "/api/proposals/" + approval.id + "/approve",
      headers: headers(userA),
      payload: {},
    });
    expect(approvedAgain.statusCode).toBe(200);
    expect(approvedAgain.json().proposal.status).toBe("AUTHORIZED");

    const rejectedProposal = await createProposal(
      userA,
      mandateA,
      versionA,
      products.get("16900")!,
    );
    const rejectedEvaluation = await app.inject({
      method: "POST",
      url: "/api/proposals/" + rejectedProposal.id + "/evaluate",
      headers: headers(userA),
      payload: {},
    });
    expect(rejectedEvaluation.json().decision.decision).toBe("REQUIRE_APPROVAL");
    const rejected = await app.inject({
      method: "POST",
      url: "/api/proposals/" + rejectedProposal.id + "/reject",
      headers: headers(userA),
      payload: {},
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().proposal.status).toBe("BLOCKED");
    const rejectedAgain = await app.inject({
      method: "POST",
      url: "/api/proposals/" + rejectedProposal.id + "/reject",
      headers: headers(userA),
      payload: {},
    });
    expect(rejectedAgain.statusCode).toBe(200);
    expect(rejectedAgain.json().proposal.status).toBe("BLOCKED");

    const blocked = await createProposal(userA, mandateA, versionA, products.get("22000")!);
    const blockedDecision = await app.inject({
      method: "POST",
      url: "/api/proposals/" + blocked.id + "/evaluate",
      headers: headers(userA),
      payload: {},
    });
    expect(blockedDecision.statusCode).toBe(200);
    expect(blockedDecision.json().decision.decision).toBe("BLOCK");
    expect(blockedDecision.json().decision.reasonCodes).toContain("TRANSACTION_LIMIT_EXCEEDED");
  });

  it("enforces ownership and lets one of two concurrent 150 dollar proposals reserve the daily cap", async () => {
    await expect(
      createProposal(userA, mandateB, versionB, products.get("15000")!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const userAMandateProposalA = await createProposal(
      userB,
      mandateB,
      versionB,
      products.get("15000")!,
    );
    const userAMandateProposalB = await createProposal(
      userB,
      mandateB,
      versionB,
      products.get("15000")!,
    );
    const ids = [userAMandateProposalA.id, userAMandateProposalB.id];
    const results = await Promise.all(
      ids.map((id) =>
        app.inject({
          method: "POST",
          url: "/api/proposals/" + id + "/evaluate",
          headers: headers(userB),
          payload: {},
        }),
      ),
    );
    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(2);
    const decisions = results.map((result) => result.json().decision.decision);
    expect(decisions.filter((decision) => decision === "ALLOW")).toHaveLength(1);
    expect(decisions.filter((decision) => decision === "BLOCK")).toHaveLength(1);

    const mandateC = await new MandateRepository(database).create({
      userId: userB,
      title: "Weekly cap test",
      originalPrompt: "Keep weekly spend bounded.",
      autoSpendLimit: 15_000n,
      transactionLimit: 18_000n,
      dailyLimit: 100_000n,
      weeklyLimit: 20_000n,
      monthlyLimit: 100_000n,
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 86_400_000),
      status: "ACTIVE",
      rules: [],
    });
    const weeklyVersion = mandateC.activeVersionId ?? "";
    const weeklyA = await createProposal(userB, mandateC.id, weeklyVersion, products.get("15000")!);
    const weeklyB = await createProposal(userB, mandateC.id, weeklyVersion, products.get("15000")!);
    const weeklyResults = await Promise.all(
      [weeklyA.id, weeklyB.id].map((id) =>
        app.inject({
          method: "POST",
          url: "/api/proposals/" + id + "/evaluate",
          headers: headers(userB),
          payload: {},
        }),
      ),
    );
    const weeklyDecisions = weeklyResults.map((result) => result.json().decision);
    expect(
      weeklyDecisions.filter((decision: { decision: string }) => decision.decision === "ALLOW"),
    ).toHaveLength(1);
    expect(
      weeklyDecisions.some(
        (decision: { decision: string; reasonCodes: string[] }) =>
          decision.decision === "BLOCK" && decision.reasonCodes.includes("WEEKLY_LIMIT_EXCEEDED"),
      ),
    ).toBe(true);
  });
});
