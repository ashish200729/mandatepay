import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "@mandatepay/database";
import { registerMandateRoutes } from "./routes/mandates.js";

try {
  process.loadEnvFile?.(fileURLToPath(new URL("../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl)
  throw new Error("TEST_DATABASE_URL is required for mandate integration tests.");
const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//u, ""));
if (!/_test$/u.test(databaseName) || process.env.DATABASE_URL === testDatabaseUrl) {
  throw new Error("Mandate integration tests require an isolated *_test database.");
}

const database = createPrismaClient(testDatabaseUrl);
const app = Fastify({ logger: false });
const origin = process.env.APP_URL ?? "http://localhost:3000";
const users = new Set<string>();
let userA = "";
let userB = "";

function canonical(overrides: Record<string, unknown> = {}) {
  const startsAt = new Date();
  const expiresAt = new Date(startsAt.getTime() + 86_400_000);
  return {
    title: "Controlled headphones",
    productIntent: "noise-cancelling headphones",
    currency: "USD",
    timezone: "UTC",
    allowedBrands: ["Sony", "Bose"],
    blockedBrands: [],
    allowedCategories: ["headphones"],
    blockedCategories: [],
    allowedConditions: ["NEW"],
    autoSpendLimit: 15_000,
    transactionLimit: 18_000,
    dailyLimit: 20_000,
    weeklyLimit: 50_000,
    monthlyLimit: 100_000,
    quantityLimit: 1,
    allowedMerchants: [],
    blockedMerchants: [],
    newMerchantRequiresApproval: false,
    startsAt: startsAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ...overrides,
  };
}

function headers(userId: string, includeOrigin = true) {
  return {
    "x-test-user": userId,
    ...(includeOrigin ? { origin } : {}),
    "content-type": "application/json",
  };
}

describe("Mandate REST routes", () => {
  beforeAll(async () => {
    const first = await database.user.create({
      data: { email: "mandate-route-a-" + Date.now() + "@mandatepay.local", name: "Mandate A" },
    });
    const second = await database.user.create({
      data: { email: "mandate-route-b-" + Date.now() + "@mandatepay.local", name: "Mandate B" },
    });
    userA = first.id;
    userB = second.id;
    users.add(userA);
    users.add(userB);

    registerMandateRoutes(app, {
      database,
      requireUser: async (request, reply) => {
        const userId = request.headers["x-test-user"];
        if (typeof userId !== "string" || !users.has(userId)) {
          await reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
          return null;
        }
        return { id: userId };
      },
      isTrustedOrigin: (requestOrigin) => requestOrigin === origin,
      parseDraft: async () => canonical(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  it("parses review-only drafts and rejects unknown input", async () => {
    const parsed = await app.inject({
      method: "POST",
      url: "/api/mandates/parse",
      headers: headers(userA),
      payload: { prompt: "Find controlled headphones." },
    });
    expect(parsed.statusCode).toBe(200);
    expect(parsed.json().status).toBe("ready");
    expect(parsed.json().mandate.transactionLimit).toBe(18_000);

    const unknown = await app.inject({
      method: "POST",
      url: "/api/mandates/parse",
      headers: headers(userA),
      payload: { prompt: "x", userId: userB },
    });
    expect(unknown.statusCode).toBe(400);
    expect(await database.mandate.count({ where: { userId: userA } })).toBe(0);
  });

  it("creates an owned draft idempotently and preserves version history", async () => {
    const body = {
      originalPrompt: "Find controlled headphones.",
      mandate: canonical(),
      requestKey: "mandate-create-" + Date.now(),
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/mandates",
      headers: headers(userA),
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    const first = created.json().mandate;
    expect(first.status).toBe("DRAFT");
    expect(first.rules.transactionLimit).toBe(18_000);

    const retry = await app.inject({
      method: "POST",
      url: "/api/mandates",
      headers: headers(userA),
      payload: body,
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().mandate.id).toBe(first.id);

    const collision = await app.inject({
      method: "POST",
      url: "/api/mandates",
      headers: headers(userA),
      payload: { ...body, originalPrompt: "Different request." },
    });
    expect(collision.statusCode).toBe(409);

    const otherUser = await app.inject({
      method: "GET",
      url: "/api/mandates/" + first.id,
      headers: headers(userB, false),
    });
    expect(otherUser.statusCode).toBe(404);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/mandates/" + first.id,
      headers: headers(userA),
      payload: {
        version: 1,
        originalPrompt: "Updated controlled headphones.",
        mandate: canonical({ title: "Updated headphones" }),
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().mandate.version).toBe(2);

    const stale = await app.inject({
      method: "PATCH",
      url: "/api/mandates/" + first.id,
      headers: headers(userA),
      payload: {
        version: 1,
        originalPrompt: "Stale update.",
        mandate: canonical({ title: "Stale" }),
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(await database.mandateVersion.count({ where: { mandateId: first.id } })).toBe(2);
  });

  it("requires explicit activation and preserves pause/resume/revoke ownership", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/mandates",
      headers: headers(userA),
      payload: {
        originalPrompt: "Activate this mandate.",
        mandate: canonical({ title: "Activation flow" }),
        requestKey: "activation-" + Date.now(),
      },
    });
    const mandate = created.json().mandate;

    const activated = await app.inject({
      method: "POST",
      url: "/api/mandates/" + mandate.id + "/activate",
      headers: headers(userA),
      payload: { version: mandate.version },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().mandate.status).toBe("ACTIVE");

    const paused = await app.inject({
      method: "POST",
      url: "/api/mandates/" + mandate.id + "/pause",
      headers: headers(userA),
      payload: { version: activated.json().mandate.version },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().mandate.status).toBe("PAUSED");

    const resumed = await app.inject({
      method: "POST",
      url: "/api/mandates/" + mandate.id + "/resume",
      headers: headers(userA),
      payload: { version: paused.json().mandate.version },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().mandate.status).toBe("ACTIVE");

    const revoked = await app.inject({
      method: "POST",
      url: "/api/mandates/" + mandate.id + "/revoke",
      headers: headers(userA),
      payload: { version: resumed.json().mandate.version },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().mandate.status).toBe("REVOKED");

    const ownerIdAttempt = await app.inject({
      method: "GET",
      url: "/api/mandates",
      headers: headers(userB, false),
    });
    expect(ownerIdAttempt.json().mandates).not.toContainEqual(
      expect.objectContaining({ id: mandate.id }),
    );
  });

  it("rejects activation outside the validity window", async () => {
    const now = Date.now();
    const created = await app.inject({
      method: "POST",
      url: "/api/mandates",
      headers: headers(userA),
      payload: {
        originalPrompt: "Expired mandate.",
        mandate: canonical({
          title: "Expired",
          startsAt: new Date(now - 7_200_000).toISOString(),
          expiresAt: new Date(now - 3_600_000).toISOString(),
        }),
        requestKey: "expired-" + Date.now(),
      },
    });
    const mandate = created.json().mandate;
    const activation = await app.inject({
      method: "POST",
      url: "/api/mandates/" + mandate.id + "/activate",
      headers: headers(userA),
      payload: { version: mandate.version },
    });
    expect(activation.statusCode).toBe(409);
  });

  it("fails closed when an invalid canonical snapshot is stored", async () => {
    const startsAt = new Date();
    const expiresAt = new Date(startsAt.getTime() + 86_400_000);
    const invalid = await database.mandate.create({
      data: {
        userId: userA,
        title: "Invalid snapshot",
        originalPrompt: "Invalid snapshot fixture.",
        status: "DRAFT",
        currency: "USD",
        autoSpendLimit: 1_000n,
        transactionLimit: 2_000n,
        dailyLimit: null,
        weeklyLimit: null,
        monthlyLimit: null,
        spendTimeZone: "UTC",
        startsAt,
        expiresAt,
        version: 1,
      },
    });
    const version = await database.mandateVersion.create({
      data: {
        mandateId: invalid.id,
        version: 1,
        title: invalid.title,
        originalPrompt: invalid.originalPrompt,
        currency: "USD",
        autoSpendLimit: 1_000n,
        transactionLimit: 2_000n,
        dailyLimit: null,
        weeklyLimit: null,
        monthlyLimit: null,
        spendTimeZone: "UTC",
        startsAt,
        expiresAt,
        canonicalRules: {
          title: invalid.title,
          productIntent: invalid.title,
          currency: "USD",
          timezone: "UTC",
          allowedBrands: ["*"],
          blockedBrands: [],
          allowedCategories: [],
          blockedCategories: [],
          allowedConditions: [],
        },
      },
    });
    await database.mandate.update({
      where: { id: invalid.id },
      data: { activeVersionId: version.id },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/mandates/" + invalid.id,
      headers: headers(userA, false),
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.stringify(response.json())).not.toContain("*");
  });
});
