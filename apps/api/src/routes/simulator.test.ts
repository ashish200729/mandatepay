import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "@mandatepay/database";
import { registerSimulatorRoutes, SimulationRequestSchema } from "./simulator.js";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const ORIGIN = "http://localhost:3000";

const demoRules = {
  title: "Demo headphones",
  productIntent: "noise-cancelling headphones",
  currency: "USD",
  timezone: "UTC",
  allowedBrands: ["Sony", "Bose"],
  blockedBrands: [],
  allowedCategories: ["Headphones"],
  blockedCategories: [],
  allowedConditions: ["NEW"],
  autoSpendLimit: 15_000,
  transactionLimit: 18_000,
  dailyLimit: 50_000,
  quantityLimit: 1,
  allowedMerchants: [],
  blockedMerchants: [],
  newMerchantRequiresApproval: false,
  startsAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-12-01T00:00:00.000Z",
};

type Fixture = {
  status?: string;
  rules?: Record<string, unknown>;
  owner?: string;
  autonomy?: boolean;
  platformAutonomy?: boolean;
  payments?: Array<{ amount: bigint; currency: string; capturedAt: Date }>;
  reservations?: Array<{
    id: string;
    amount: bigint;
    currency: string;
    window: string;
    expiresAt: Date;
    proposal: {
      status: string;
      payment: null | { status: string; paypalCaptureId: string | null };
    };
  }>;
  merchantPayments?: number;
};

/**
 * A transaction double that only implements reads. Any other model method —
 * create, update, upsert, delete — is recorded as a write attempt and fails.
 */
function fakeDatabase(fixture: Fixture = {}) {
  const calls: string[] = [];
  const writes: string[] = [];
  const models: Record<string, Record<string, (args?: unknown) => Promise<unknown>>> = {
    mandate: {
      findFirst: async (args) => {
        const where = (args as { where: { id: string; userId: string } }).where;
        if (where.userId !== (fixture.owner ?? "user-1") || where.id !== "mandate-1") return null;
        return {
          id: "mandate-1",
          status: fixture.status ?? "ACTIVE",
          startsAt: new Date("2026-10-01T00:00:00.000Z"),
          expiresAt: new Date("2026-12-01T00:00:00.000Z"),
          activeVersion: {
            id: "version-3",
            version: 3,
            currency: "USD",
            canonicalRules: fixture.rules ?? demoRules,
          },
        };
      },
    },
    user: {
      findUnique: async () => ({
        globalAutonomousPurchasingEnabled: fixture.autonomy ?? true,
        disabledAt: null,
      }),
    },
    payment: {
      findMany: async () => fixture.payments ?? [],
      count: async () => fixture.merchantPayments ?? 1,
    },
    spendReservation: { findMany: async () => fixture.reservations ?? [] },
    platformSetting: {
      findMany: async () =>
        fixture.platformAutonomy === false
          ? [{ key: "payments.autonomyEnabledGlobally", valueJson: false }]
          : [],
    },
  };
  const proxyModel = (name: string) =>
    new Proxy(models[name] ?? {}, {
      get(target, method: string) {
        const read = target[method];
        if (read) {
          return async (args?: unknown) => {
            calls.push(`${name}.${method}`);
            return read(args);
          };
        }
        return async () => {
          writes.push(`${name}.${method}`);
          throw new Error("write attempted in a read-only simulation");
        };
      },
    });
  const tx = new Proxy(
    {
      $executeRawUnsafe: async (sql: string) => {
        calls.push(`raw:${sql}`);
        return 0;
      },
    } as Record<string, unknown>,
    {
      get(target, key: string) {
        if (key in target) return target[key];
        return proxyModel(key);
      },
    },
  );
  const database = {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  } as unknown as DatabaseClient;
  return { database, calls, writes };
}

const apps: ReturnType<typeof Fastify>[] = [];

function buildApp(fixture: Fixture = {}, options: { rateLimitPerMinute?: number } = {}) {
  const fake = fakeDatabase(fixture);
  const app = Fastify();
  apps.push(app);
  registerSimulatorRoutes(app, {
    database: fake.database,
    requireUser: async (request, reply) => {
      const user = request.headers["x-test-user"];
      if (typeof user !== "string") {
        await reply.status(401).send({ error: "Unauthorized" });
        return null;
      }
      return { id: user };
    },
    isTrustedOrigin: (origin) => origin === ORIGIN,
    rateLimitPerMinute: options.rateLimitPerMinute,
    now: () => NOW,
  });
  return { app, ...fake };
}

function simulate(
  app: ReturnType<typeof Fastify>,
  payload: unknown,
  headers: Record<string, string> = { "x-test-user": "user-1", origin: ORIGIN },
  id = "mandate-1",
) {
  return app.inject({ method: "POST", url: `/api/mandates/${id}/simulate`, headers, payload });
}

const sony = (price: number) => ({
  price,
  quantity: 1,
  condition: "NEW",
  brand: "Sony",
  category: "Headphones",
  merchant: "Mandate Demo Store",
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("AgentGuard policy simulator route", () => {
  it.each([
    [13_900, "ALLOW", []],
    [16_900, "REQUIRE_APPROVAL", ["AUTO_SPEND_THRESHOLD_EXCEEDED"]],
    [22_000, "BLOCK", ["TRANSACTION_LIMIT_EXCEEDED"]],
  ] as const)("evaluates $%s with the real engine", async (price, decision, codes) => {
    const { app, writes } = buildApp();
    const response = await simulate(app, sony(price));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ simulated: true, decision, reasonCodes: codes });
    expect(body.explanation.decision).toBe(decision);
    expect(body.explanation.headline.length).toBeGreaterThan(0);
    expect(body.facts).toMatchObject({ total: price, currency: "USD", isNewMerchant: false });
    expect(body.mandate).toEqual({ id: "mandate-1", version: 3, status: "ACTIVE" });
    expect(writes).toEqual([]);
  });

  it("explains a hard block as not overridable by approval", async () => {
    const { app } = buildApp();
    const body = (
      await simulate(app, { ...sony(12_000), brand: "Bose", condition: "REFURBISHED" })
    ).json();
    expect(body.decision).toBe("BLOCK");
    expect(body.reasonCodes).toEqual(["CONDITION_NOT_ALLOWED"]);
    expect(body.explanation.approvalCanOverride).toBe(false);
    const condition = body.explanation.checks.find(
      (check: { rule: string }) => check.rule === "condition",
    );
    expect(condition.status).toBe("block");
  });

  it("runs inside a READ ONLY transaction and never writes", async () => {
    const { app, calls, writes } = buildApp();
    await simulate(app, sony(16_900));
    expect(calls[0]).toBe("raw:SET TRANSACTION READ ONLY");
    expect(calls).toContain("mandate.findFirst");
    expect(writes).toEqual([]);
    expect(calls.some((call) => /create|update|upsert|delete/iu.test(call))).toBe(false);
  });

  it.each([
    ["PAUSED", "MANDATE_INACTIVE"],
    ["REVOKED", "MANDATE_REVOKED"],
    ["EXPIRED", "MANDATE_EXPIRED"],
  ])("returns the real hard block for a %s mandate", async (status, code) => {
    const { app } = buildApp({ status });
    const response = await simulate(app, sony(13_900));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ decision: "BLOCK", reasonCodes: [code] });
  });

  it("blocks a mandate past its stored expiry even when the rules omit it", async () => {
    const { app } = buildApp({
      rules: { ...demoRules, startsAt: undefined, expiresAt: undefined },
    });
    // The stored window is Oct 1 – Dec 1, so this proves the fill keeps ALLOW inside it.
    expect((await simulate(app, sony(13_900))).json().decision).toBe("ALLOW");
    const late = Fastify();
    apps.push(late);
    const fake = fakeDatabase({
      rules: { ...demoRules, startsAt: undefined, expiresAt: undefined },
    });
    registerSimulatorRoutes(late, {
      database: fake.database,
      requireUser: async () => ({ id: "user-1" }),
      isTrustedOrigin: () => true,
      now: () => new Date("2026-12-02T00:00:00.000Z"),
    });
    const body = (await simulate(late, sony(13_900))).json();
    expect(body.decision).toBe("BLOCK");
    expect(body.reasonCodes).toContain("MANDATE_EXPIRED");
  });

  it("uses the user and platform autonomy switches like a real evaluation", async () => {
    const userOff = buildApp({ autonomy: false });
    const off = (await simulate(userOff.app, sony(13_900))).json();
    expect(off).toMatchObject({
      decision: "REQUIRE_APPROVAL",
      reasonCodes: ["GLOBAL_AUTONOMY_DISABLED"],
    });
    const platformOff = buildApp({ platformAutonomy: false });
    expect((await simulate(platformOff.app, sony(13_900))).json()).toMatchObject({
      decision: "REQUIRE_APPROVAL",
      reasonCodes: ["GLOBAL_AUTONOMY_DISABLED"],
    });
  });

  it("detects a new store from history and lets the toggle override it", async () => {
    const rules = { ...demoRules, newMerchantRequiresApproval: true };
    const known = buildApp({ rules, merchantPayments: 2 });
    expect((await simulate(known.app, sony(13_900))).json()).toMatchObject({
      decision: "ALLOW",
      facts: { isNewMerchant: false, newMerchantSource: "history" },
    });
    const fresh = buildApp({ rules, merchantPayments: 0 });
    expect((await simulate(fresh.app, sony(13_900))).json()).toMatchObject({
      decision: "REQUIRE_APPROVAL",
      reasonCodes: ["NEW_MERCHANT_REQUIRES_APPROVAL"],
      facts: { isNewMerchant: true, newMerchantSource: "history" },
    });
    const forced = buildApp({ rules, merchantPayments: 5 });
    expect(
      (await simulate(forced.app, { ...sony(13_900), asNewMerchant: true })).json(),
    ).toMatchObject({
      decision: "REQUIRE_APPROVAL",
      facts: { isNewMerchant: true, newMerchantSource: "override" },
    });
  });

  it("counts confirmed spend and live holds, but not a hold a real evaluation would release", async () => {
    const base = {
      currency: "USD",
      window: "TRANSACTION",
      proposal: { status: "AUTHORIZED", payment: null },
    };
    const { app, writes } = buildApp({
      payments: [
        { amount: 30_000n, currency: "USD", capturedAt: new Date("2026-10-12T08:00:00Z") },
      ],
      reservations: [
        // Expired and unpaid: a real evaluation releases it, so it is ignored here.
        { ...base, id: "stale", amount: 10_000n, expiresAt: new Date("2026-10-12T11:00:00Z") },
      ],
    });
    // 300 confirmed + 139 = 439 ≤ 500 daily.
    expect((await simulate(app, sony(13_900))).json().decision).toBe("ALLOW");
    expect(writes).toEqual([]);

    const held = buildApp({
      payments: [
        { amount: 30_000n, currency: "USD", capturedAt: new Date("2026-10-12T08:00:00Z") },
      ],
      reservations: [
        { ...base, id: "live", amount: 10_000n, expiresAt: new Date("2026-10-12T13:00:00Z") },
      ],
    });
    // 300 confirmed + 100 held + 139 = 539 > 500 daily.
    const body = (await simulate(held.app, sony(13_900))).json();
    expect(body.decision).toBe("BLOCK");
    expect(body.reasonCodes).toEqual(["DAILY_LIMIT_EXCEEDED"]);
    expect(
      body.explanation.checks.find((check: { rule: string }) => check.rule === "daily_limit")
        .status,
    ).toBe("block");
  });

  it("keeps an expired hold whose capture may already have happened", async () => {
    const { app } = buildApp({
      payments: [
        { amount: 30_000n, currency: "USD", capturedAt: new Date("2026-10-12T08:00:00Z") },
      ],
      reservations: [
        {
          id: "capturing",
          amount: 10_000n,
          currency: "USD",
          window: "TRANSACTION",
          expiresAt: new Date("2026-10-12T11:00:00Z"),
          proposal: {
            status: "PAYMENT_PENDING",
            payment: { status: "CAPTURE_PENDING", paypalCaptureId: null },
          },
        },
      ],
    });
    expect((await simulate(app, sony(13_900))).json().reasonCodes).toEqual([
      "DAILY_LIMIT_EXCEEDED",
    ]);
  });

  it("returns 404 for a mandate the user does not own", async () => {
    const { app, calls } = buildApp({ owner: "someone-else" });
    const response = await simulate(app, sony(13_900));
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Mandate not found.", code: "NOT_FOUND" });
    expect(calls).not.toContain("payment.findMany");
  });

  it("rejects untrusted origins and unauthenticated callers before reading", async () => {
    const { app, calls } = buildApp();
    const foreign = await simulate(app, sony(13_900), {
      "x-test-user": "user-1",
      origin: "https://evil.example",
    });
    expect(foreign.statusCode).toBe(403);
    const anonymous = await simulate(app, sony(13_900), { origin: ORIGIN });
    expect(anonymous.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it.each([
    ["a fractional price", { ...sony(0), price: 139.5 }],
    ["a zero price", sony(0)],
    ["a string price", { ...sony(0), price: "139" }],
    ["a negative shipping", { ...sony(13_900), shipping: -1 }],
    ["a price above the cap", sony(100_000_001)],
    ["quantity 0", { ...sony(13_900), quantity: 0 }],
    ["an unknown condition", { ...sony(13_900), condition: "OPEN_BOX" }],
    ["a missing merchant", { ...sony(13_900), merchant: "   " }],
    ["an unknown field", { ...sony(13_900), proposalId: "p-1" }],
    ["a non-boolean toggle", { ...sony(13_900), asNewMerchant: "yes" }],
  ])("rejects %s", async (_label, payload) => {
    const { app, calls } = buildApp();
    const response = await simulate(app, payload);
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_REQUEST");
    expect(calls).toEqual([]);
  });

  it("treats blank brand and category as missing product facts", async () => {
    const parsed = SimulationRequestSchema.parse({ ...sony(13_900), brand: " ", category: "" });
    expect(parsed.brand).toBeUndefined();
    expect(parsed.category).toBeUndefined();
    expect(parsed.shipping).toBe(0);
    const { app } = buildApp();
    const body = (await simulate(app, { ...sony(13_900), brand: "" })).json();
    expect(body.decision).toBe("BLOCK");
    expect(body.reasonCodes).toEqual(["PRODUCT_DATA_UNTRUSTED"]);
  });

  it("includes shipping and tax in the evaluated total", async () => {
    const { app } = buildApp();
    const body = (await simulate(app, { ...sony(13_900), shipping: 1_000, tax: 1_200 })).json();
    expect(body.facts.total).toBe(16_100);
    expect(body.decision).toBe("REQUIRE_APPROVAL");
  });

  it("rate limits each user separately", async () => {
    const { app } = buildApp({}, { rateLimitPerMinute: 2 });
    expect((await simulate(app, sony(13_900))).statusCode).toBe(200);
    expect((await simulate(app, sony(13_900))).statusCode).toBe(200);
    const limited = await simulate(app, sony(13_900));
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    const other = await simulate(app, sony(13_900), { "x-test-user": "user-2", origin: ORIGIN });
    expect(other.statusCode).toBe(404);
  });

  it("hides internal failures behind a safe 503", async () => {
    const app = Fastify();
    apps.push(app);
    registerSimulatorRoutes(app, {
      database: {
        $transaction: vi.fn(async () => {
          throw new Error("connection string postgres://secret");
        }),
      } as unknown as DatabaseClient,
      requireUser: async () => ({ id: "user-1" }),
      isTrustedOrigin: () => true,
    });
    const response = await simulate(app, sony(13_900));
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("secret");
  });
});
