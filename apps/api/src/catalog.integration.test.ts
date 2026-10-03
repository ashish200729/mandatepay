import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, MandateRepository } from "@mandatepay/database";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { canonicalToCreateInput, parseCanonicalMandate } from "./services/mandates.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (
  !databaseUrl ||
  !new URL(databaseUrl).pathname.endsWith("_test") ||
  databaseUrl === process.env.DATABASE_URL
) {
  throw new Error("Catalog integration requires an isolated *_test database.");
}
const database = createPrismaClient(databaseUrl);
const app = Fastify({ logger: false });
const origin = "http://localhost:3000";
let owner = "";
let other = "";
let mandateId = "";
function headers(user = owner) {
  return { origin, "x-test-user": user };
}

describe("controlled demo catalog and server proposals", () => {
  beforeAll(async () => {
    owner = (
      await database.user.create({
        data: { email: `catalog-${crypto.randomUUID()}@mandatepay.local`, name: "Catalog owner" },
      })
    ).id;
    other = (
      await database.user.create({
        data: { email: `catalog-${crypto.randomUUID()}@mandatepay.local`, name: "Other owner" },
      })
    ).id;
    const rules = parseCanonicalMandate({
      title: "Headphones",
      productIntent: "headphones",
      currency: "USD",
      timezone: "UTC",
      allowedBrands: ["Sony", "Bose"],
      blockedBrands: [],
      allowedCategories: ["headphones"],
      blockedCategories: [],
      allowedConditions: ["NEW"],
      autoSpendLimit: 15000,
      transactionLimit: 18000,
      quantityLimit: 1,
      allowedMerchants: [],
      blockedMerchants: [],
      newMerchantRequiresApproval: false,
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const repository = new MandateRepository(database);
    const draft = await repository.create(
      canonicalToCreateInput(owner, "Controlled headphones", rules),
    );
    mandateId = draft.id;
    await repository.activate(mandateId, owner, draft.version);
    registerCatalogRoutes(app, {
      database,
      mode: "demo",
      isTrustedOrigin: (value) => value === origin,
      requireUser: async (request, reply) => {
        const value = request.headers["x-test-user"];
        if (value !== owner && value !== other) {
          reply.status(401).send({ error: "Unauthorized" });
          return null;
        }
        return { id: value };
      },
      rank: async () => ({ recommendations: [] }),
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });
  it("labels search results and enforces owner and origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/products/search",
      headers: headers(),
      payload: { mandateId, query: "headphones" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().mode).toBe("demo");
    expect(response.json().products).toHaveLength(3);
    expect(response.json().notice).toContain("Demo Catalog");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/products/search",
          headers: headers(other),
          payload: { mandateId },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/products/search",
          headers: { ...headers(), origin: "https://untrusted.example" },
          payload: { mandateId },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("computes authoritative cents, rejects client prices, and preserves idempotent snapshots", async () => {
    const body = {
      mandateId,
      source: "demo",
      productId: "demo-headphones-169",
      quantity: 1,
      requestKey: crypto.randomUUID(),
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/proposals",
          headers: headers(),
          payload: { ...body, total: 1 },
        })
      ).statusCode,
    ).toBe(400);
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/api/proposals", headers: headers(), payload: body }),
      app.inject({ method: "POST", url: "/api/proposals", headers: headers(), payload: body }),
    ]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().proposal.id).toBe(second.json().proposal.id);
    expect(first.json().proposal.total).toBe(16900);
    expect(first.json().proposal.shipping).toBe(0);
    const stored = await database.purchaseProposal.findUniqueOrThrow({
      where: { id: first.json().proposal.id },
      include: { productSnapshot: true },
    });
    expect(stored.status).toBe("PROPOSED");
    expect(stored.productSnapshot.price).toBe(16900n);
    expect(
      await database.auditEvent.count({
        where: { entityId: stored.id, eventType: "PURCHASE_PROPOSAL_CREATED" },
      }),
    ).toBe(1);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/proposals",
          headers: headers(),
          payload: { ...body, quantity: 2 },
        })
      ).statusCode,
    ).toBe(409);
    // Over-limit requests are persisted first; AgentGuard records the BLOCK decision later.
    const over = await app.inject({
      method: "POST",
      url: "/api/proposals",
      headers: headers(),
      payload: { ...body, quantity: 2, requestKey: crypto.randomUUID() },
    });
    expect(over.statusCode).toBe(201);
    expect(over.json().proposal.total).toBe(33800);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/proposals",
          headers: headers(),
          payload: { ...body, source: "channel3" },
        })
      ).statusCode,
    ).toBe(409);
  });
});
