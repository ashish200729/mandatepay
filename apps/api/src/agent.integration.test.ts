import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, MandateRepository } from "@mandatepay/database";
import { registerShoppingAgentRoutes } from "./routes/agent.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for agent integration tests.");
const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//u, ""));
if (!/_test$/u.test(databaseName) || process.env.DATABASE_URL === testDatabaseUrl) {
  throw new Error("Agent integration tests require an isolated *_test database.");
}

const database = createPrismaClient(testDatabaseUrl);
const app = Fastify({ logger: false });
const origin = process.env.APP_URL ?? "http://localhost:3000";
let userId = "";
let mandateId = "";
let proposalStatus = "PROPOSED";
let evaluationCount = 0;
const cookie = () => `x-test-user=${userId}`;

function headers() {
  return { cookie: cookie(), origin, "content-type": "application/json" };
}

describe("shopping agent route adapter", () => {
  beforeAll(async () => {
    const user = await database.user.create({
      data: {
        email: `agent-route-${Date.now()}@mandatepay.local`,
        name: "Agent Route User",
        globalAutonomousPurchasingEnabled: true,
      },
    });
    userId = user.id;
    const now = Date.now();
    const mandate = await new MandateRepository(database).create({
      userId,
      title: "Agent route mandate",
      originalPrompt: "Buy demo headphones under control.",
      autoSpendLimit: 20_000n,
      transactionLimit: 20_000n,
      dailyLimit: 100_000n,
      weeklyLimit: 100_000n,
      monthlyLimit: 100_000n,
      startsAt: new Date(now - 60_000),
      expiresAt: new Date(now + 86_400_000),
      status: "ACTIVE",
      canonicalRules: {
        title: "Agent route mandate",
        productIntent: "demo headphones",
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
    mandateId = mandate.id;

    const requireUser = async (
      request: { headers: Record<string, string | string[] | undefined> },
      reply: { status: (code: number) => { send: (body: unknown) => void } },
    ) => {
      const header = request.headers["x-test-user"];
      const cookieHeader = request.headers.cookie;
      const value =
        typeof header === "string"
          ? header
          : typeof cookieHeader === "string"
            ? cookieHeader.replace(/^x-test-user=/u, "")
            : "";
      if (value !== userId) {
        reply.status(401).send({ error: "Unauthorized" });
        return null;
      }
      return { id: userId };
    };

    app.post("/api/products/search", async () => ({
      products: [
        {
          source: "demo",
          externalId: "demo-headphones-139",
          title: "Demo headphones",
          brand: "Sony",
          category: "Headphones",
          condition: "NEW",
          priceMinor: 13_900,
          currency: "USD",
          merchant: "Demo Merchant",
        },
      ],
    }));
    app.post("/api/proposals", async () => ({
      proposal: { id: "proposal-agent-route", status: proposalStatus },
    }));
    app.post("/api/proposals/:id/evaluate", async () => {
      evaluationCount += 1;
      proposalStatus = "AUTHORIZED";
      return {
        proposal: { id: "proposal-agent-route", status: "AUTHORIZED" },
        decision: { decision: "ALLOW", reasonCodes: [] },
      };
    });
    app.get("/api/proposals/:id", async () => ({
      proposal: { id: "proposal-agent-route", status: proposalStatus },
      decision: { decision: "ALLOW", reasonCodes: [] },
    }));

    registerShoppingAgentRoutes(app, {
      app,
      database,
      appUrl: origin,
      requireUser: requireUser as never,
      isTrustedOrigin: (requestOrigin) => requestOrigin === origin,
      modelId: "test-model",
      runner: async (input, tools) => {
        if (input.message === "Find my previous headphones purchase") {
          const transactions = await tools.find_transaction?.(
            { transactionId: null, query: "headphones" },
            { signal: new AbortController().signal },
          );
          expect(transactions).toEqual({ transactions: [] });
          const search = await tools.search_products?.(
            { query: "headphones", maximumPriceMinor: null, brands: [], category: null },
            { signal: new AbortController().signal },
          );
          expect(search).toEqual({ error: "Select exactly one active purchase mandate first." });
          return {
            status: "completed",
            rounds: 1,
            trace: [],
            finalAIExplanation: {
              kind: "explanation",
              text: "No matching previous purchase was found.",
              paymentAuthoritative: false,
            },
          };
        }
        const mandates = await tools.get_active_mandates?.(
          {},
          { signal: new AbortController().signal },
        );
        expect(mandates).toMatchObject({
          mandates: [{ id: mandateId, rules: { transactionLimit: 20_000 } }],
        });
        const toolNames = Object.keys(tools);
        if (toolNames.includes("spend_money") || toolNames.includes("approve_payment")) {
          throw new Error("forbidden financial tool exposed");
        }
        const search = await tools.search_products?.(
          { query: "headphones", maximumPriceMinor: null, brands: [], category: null },
          { signal: new AbortController().signal },
        );
        const proposal = await tools.create_purchase_proposal?.(
          { productId: "demo-headphones-139", source: "demo", quantity: 1 },
          { signal: new AbortController().signal },
        );
        return {
          status: "completed",
          rounds: 1,
          trace: [
            {
              round: 1,
              callId: "search",
              name: "search_products",
              arguments: {},
              status: "completed",
              result: search,
            },
            {
              round: 1,
              callId: "proposal",
              name: "create_purchase_proposal",
              arguments: {},
              status: "completed",
              result: proposal,
            },
          ],
          finalAIExplanation: {
            kind: "explanation",
            text: "I found a matching product and prepared it for review.",
            paymentAuthoritative: false,
          },
        };
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it("runs server-owned tools and returns actual proposal facts", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/chat",
      headers: headers(),
      payload: { message: "Find and prepare headphones", mandateId, requestKey: "agent-request-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().proposals[0].proposal.id).toBe("proposal-agent-route");
    expect(response.json().explanation.paymentAuthoritative).toBe(false);
    expect(response.json().steps.map((step: { name: string }) => step.name)).toEqual([
      "get_active_mandates",
      "search_products",
      "create_purchase_proposal",
    ]);
  });

  it("replays an already evaluated proposal without evaluating or reserving again", async () => {
    const before = evaluationCount;
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/chat",
      headers: headers(),
      payload: { message: "Find and prepare headphones", mandateId, requestKey: "agent-request-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().proposals[0].proposal.status).toBe("AUTHORIZED");
    expect(evaluationCount).toBe(before);
  });

  it("allows transaction lookup without an active purchase mandate but denies purchase tools", async () => {
    await database.mandate.update({ where: { id: mandateId }, data: { status: "PAUSED" } });
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/chat",
      headers: headers(),
      payload: { message: "Find my previous headphones purchase", requestKey: "refund-lookup-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().steps).toEqual([{ name: "find_transaction", status: "completed" }]);
  });

  it("rejects extra client authority and untrusted origins", async () => {
    const extra = await app.inject({
      method: "POST",
      url: "/api/agent/chat",
      headers: headers(),
      payload: { message: "Find headphones", mandateId, requestKey: "agent-request-2", amount: 1 },
    });
    expect(extra.statusCode).toBe(400);
    const originRejected = await app.inject({
      method: "POST",
      url: "/api/agent/chat",
      headers: { ...headers(), origin: "https://attacker.example" },
      payload: { message: "Find headphones", mandateId, requestKey: "agent-request-3" },
    });
    expect(originRejected.statusCode).toBe(403);
  });
});
