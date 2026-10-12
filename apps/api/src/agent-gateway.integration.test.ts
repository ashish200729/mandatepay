import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";

const { createApp } = await import("./app.js");
const { createAuthRuntime } = await import("./auth.js");
const { MandateRepository, createPrismaClient } = await import("@mandatepay/database");
type DatabaseClient = import("@mandatepay/database").DatabaseClient;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl)
  throw new Error("TEST_DATABASE_URL is required for agent gateway integration tests.");
const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//u, ""));
if (!/_test$/u.test(databaseName) || process.env.DATABASE_URL === testDatabaseUrl) {
  throw new Error("Agent gateway integration tests require an isolated *_test database.");
}
const authSecret = process.env.AUTH_SECRET ?? "integration-test-only-session-secret-32-characters";
const appUrl = "http://localhost:3000";
const gateway = "/api/agent-gateway/v1";
const runId = randomUUID().slice(0, 10);

const database = createPrismaClient(testDatabaseUrl);
/** Platform-control rows seen by the app; the real global settings table is never written. */
let controlRows: Array<{ key: string; valueJson: unknown }> = [];
function withControls(client: object): object {
  return new Proxy(client, {
    get(target, property) {
      if (property === "platformSetting") return { findMany: async () => controlRows };
      if (property === "$transaction") {
        return (input: unknown, options?: unknown) =>
          typeof input === "function"
            ? (target as DatabaseClient).$transaction(
                (tx) => (input as (tx: unknown) => Promise<unknown>)(withControls(tx)),
                options as never,
              )
            : (target as DatabaseClient).$transaction(input as never, options as never);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
const appDatabase = withControls(database) as DatabaseClient;

const runtime = createAuthRuntime({
  database: appDatabase,
  databaseUrl: testDatabaseUrl,
  authSecret,
  appUrl,
  nodeEnv: "test",
  requireEmailVerification: false,
});
let server: Awaited<ReturnType<typeof createApp>>;
const userIds: string[] = [];
const json = { origin: appUrl, "content-type": "application/json", accept: "application/json" };

function cookieHeader(response: { headers: Record<string, unknown> }) {
  const value = response.headers["set-cookie"];
  const cookies = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return cookies.map((cookie) => String(cookie).split(";", 1)[0] ?? "").join("; ");
}

async function signUp(label: string) {
  const response = await server.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: json,
    payload: {
      name: `Gateway ${label}`,
      email: `gateway-${label}-${runId}@mandatepay.local`,
      password: `Gateway-${runId}-password`,
    },
  });
  expect(response.statusCode).toBe(200);
  const userId = response.json().user.id as string;
  userIds.push(userId);
  return { userId, cookie: cookieHeader(response) };
}

async function createMandate(userId: string) {
  const now = Date.now();
  const rules = {
    title: "Gateway headphones",
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
  };
  const mandate = await new MandateRepository(database).create({
    userId,
    title: rules.title,
    originalPrompt: "Buy Sony or Bose headphones, new only, automatically up to $150.",
    autoSpendLimit: 15_000n,
    transactionLimit: 18_000n,
    dailyLimit: 1_000_000n,
    weeklyLimit: 1_000_000n,
    monthlyLimit: 1_000_000n,
    startsAt: new Date(now - 60_000),
    expiresAt: new Date(now + 86_400_000),
    status: "ACTIVE",
    canonicalRules: rules,
  });
  return mandate.id;
}

async function createToken(
  cookie: string,
  scopes: string[],
  name = "Claude Desktop",
  expiresInDays = 30,
) {
  const response = await server.inject({
    method: "POST",
    url: "/api/agent-tokens",
    headers: { ...json, cookie },
    payload: { name, scopes, expiresInDays },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as {
    token: string;
    agentToken: { id: string; tokenPrefix: string; scopes: string[]; status: string };
    gateway: { baseUrl: string };
  };
}

function call(
  token: string | null,
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
  extra: Record<string, string> = {},
) {
  return server.inject({
    method,
    url: `${gateway}${path}`,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...extra,
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

describe("agent access tokens and the MCP agent gateway", () => {
  let owner: { userId: string; cookie: string };
  let stranger: { userId: string; cookie: string };
  let mandateId = "";
  let strangerMandateId = "";
  let readToken = "";
  let proposeToken = "";
  let proposeTokenId = "";
  let strangerToken = "";

  beforeAll(async () => {
    server = await createApp({
      authRuntime: runtime,
      database: appDatabase,
      paypalClient: null,
      testAuthPostMaximum: 100,
      config: {
        HOST: "127.0.0.1",
        PORT: 4000,
        WEB_ORIGIN: appUrl,
        LOG_LEVEL: "silent",
        NODE_ENV: "test",
        APP_URL: appUrl,
        API_URL: "http://localhost:4000",
        DATABASE_URL: testDatabaseUrl,
        AUTH_SECRET: authSecret,
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        PAYPAL_ENV: "sandbox",
        PRODUCT_DISCOVERY_MODE: "demo",
      },
    });
    owner = await signUp("owner");
    stranger = await signUp("stranger");
    await database.user.update({
      where: { id: owner.userId },
      data: { globalAutonomousPurchasingEnabled: true },
    });
    mandateId = await createMandate(owner.userId);
    strangerMandateId = await createMandate(stranger.userId);
  });

  afterAll(async () => {
    await server?.close();
    if (userIds.length) {
      await database.agentAccessToken.deleteMany({ where: { userId: { in: userIds } } });
    }
    await database.$disconnect();
  });

  it("creates tokens from a trusted session, stores only an HMAC and shows the token once", async () => {
    const untrusted = await server.inject({
      method: "POST",
      url: "/api/agent-tokens",
      headers: { ...json, origin: "https://evil.example", cookie: owner.cookie },
      payload: { name: "Evil", scopes: ["READ"], expiresInDays: 7 },
    });
    expect(untrusted.statusCode).toBe(403);
    const anonymous = await server.inject({
      method: "POST",
      url: "/api/agent-tokens",
      headers: json,
      payload: { name: "Anon", scopes: ["READ"], expiresInDays: 7 },
    });
    expect(anonymous.statusCode).toBe(401);
    for (const payload of [
      { name: "No read", scopes: ["PROPOSE"], expiresInDays: 7 },
      { name: "Autopay alone", scopes: ["READ", "AUTOPAY"], expiresInDays: 7 },
      { name: "Too long", scopes: ["READ"], expiresInDays: 365 },
      { name: "", scopes: ["READ"], expiresInDays: 7 },
      { name: "Extra", scopes: ["READ"], expiresInDays: 7, userId: stranger.userId },
    ]) {
      const invalid = await server.inject({
        method: "POST",
        url: "/api/agent-tokens",
        headers: { ...json, cookie: owner.cookie },
        payload,
      });
      expect(invalid.statusCode).toBe(400);
    }

    const created = await createToken(owner.cookie, ["READ"], "Claude Desktop", 7);
    readToken = created.token;
    expect(readToken).toMatch(/^mp_agent_[A-Za-z0-9_-]{43}$/u);
    expect(created.agentToken).toMatchObject({ scopes: ["READ"], status: "ACTIVE" });
    expect(readToken.startsWith(created.agentToken.tokenPrefix)).toBe(true);
    expect(created.gateway.baseUrl).toBe("http://localhost:4000/api/agent-gateway/v1");

    const stored = await database.agentAccessToken.findUniqueOrThrow({
      where: { id: created.agentToken.id },
    });
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain(readToken);
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(7 * 86_400_000);

    const listed = await server.inject({
      method: "GET",
      url: "/api/agent-tokens",
      headers: { cookie: owner.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(readToken);
    expect(listed.json().agentTokens).toHaveLength(1);

    const audit = await database.auditEvent.findFirstOrThrow({
      where: { userId: owner.userId, eventType: "AGENT_TOKEN_CREATED" },
    });
    expect(JSON.stringify(audit.payload)).not.toContain(readToken);
    expect(audit.payload).toMatchObject({ agentTokenId: created.agentToken.id, scopes: ["READ"] });

    const propose = await createToken(owner.cookie, ["PROPOSE", "READ"], "Cursor agent", 90);
    proposeToken = propose.token;
    proposeTokenId = propose.agentToken.id;
    expect(propose.agentToken.scopes).toEqual(["READ", "PROPOSE"]);
    strangerToken = (await createToken(stranger.cookie, ["READ", "PROPOSE"], "Stranger")).token;
  });

  it("authenticates only bearer agent tokens, never cookies", async () => {
    const missing = await call(null, "GET", "/mandates");
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toMatch(/^Bearer /u);
    const cookieOnly = await call(null, "GET", "/mandates", undefined, { cookie: owner.cookie });
    expect(cookieOnly.statusCode).toBe(401);
    for (const header of [
      "Bearer not-a-token",
      `Basic ${readToken}`,
      `Bearer mp_agent_${"A".repeat(43)}`,
      `Bearer ${readToken}x`,
    ]) {
      const response = await server.inject({
        method: "GET",
        url: `${gateway}/mandates`,
        headers: { authorization: header },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("AGENT_TOKEN_INVALID");
    }
    // A forged internal principal is refused on the customer routes.
    const forged = await server.inject({
      method: "POST",
      url: "/api/proposals",
      headers: { ...json, "x-mandatepay-gateway-principal": "A".repeat(43) },
      payload: {
        mandateId,
        source: "demo",
        productId: "demo-headphones-139",
        quantity: 1,
        requestKey: "forged-key",
      },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("lists active mandates with summary rules and records lastUsedAt", async () => {
    const response = await call(readToken, "GET", "/mandates");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const { mandates } = response.json();
    expect(mandates).toHaveLength(1);
    expect(mandates[0]).toMatchObject({
      id: mandateId,
      active: true,
      rules: { transactionLimitMinor: 18_000, autoSpendLimitMinor: 15_000 },
    });
    expect(JSON.stringify(mandates)).not.toContain("originalPrompt");
    const detail = await call(readToken, "GET", `/mandates/${mandateId}`);
    expect(detail.statusCode).toBe(200);
    expect((await call(readToken, "GET", `/mandates/${strangerMandateId}`)).statusCode).toBe(404);
    const token = await database.agentAccessToken.findFirstOrThrow({
      where: { userId: owner.userId, name: "Claude Desktop" },
    });
    expect(token.lastUsedAt).not.toBeNull();
  });

  it("searches with the chat's mandate pre-screen and prompt-injection screening", async () => {
    const response = await call(readToken, "POST", "/products/search", {
      mandateId,
      query: "Sony headphones",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ids = body.products.map((product: { productId: string }) => product.productId);
    expect(ids).toContain("demo-headphones-139");
    const listed = body.products.find(
      (product: { productId: string }) => product.productId === "demo-headphones-139",
    );
    expect(listed).toMatchObject({ priceMinor: 13_900, checkoutEligible: true });
    expect(listed.listing).toContain("Sony");
    const injected = body.excluded.find(
      (product: { productId: string }) => product.productId === "demo-headphones-openbox-135",
    );
    expect(injected).toMatchObject({ promptInjection: true });
    expect(injected.reasons.length).toBeGreaterThan(0);
    expect(injected.listing).not.toMatch(/ignore the customer/iu);
    expect(ids).not.toContain("demo-headphones-openbox-135");

    const capped = await call(readToken, "POST", "/products/search", {
      mandateId,
      query: "Sony headphones",
      maxPriceMinor: 13_000,
    });
    expect(
      capped
        .json()
        .products.every((product: { priceMinor: number }) => product.priceMinor <= 13_000),
    ).toBe(true);
    expect(
      (await call(readToken, "POST", "/products/search", { mandateId: strangerMandateId }))
        .statusCode,
    ).toBe(404);

    const telemetry = await database.agentRunMetric.findFirst({
      where: { userId: owner.userId, modelId: "external:claude-desktop" },
    });
    expect(telemetry).not.toBeNull();
  });

  it("simulates a purchase read-only", async () => {
    const before = await database.purchaseProposal.count({ where: { userId: owner.userId } });
    const response = await call(readToken, "POST", `/mandates/${mandateId}/simulate`, {
      price: 13_900,
      condition: "NEW",
      brand: "Sony",
      category: "Headphones",
      merchant: "Mandate Demo Store",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ simulated: true });
    expect(await database.purchaseProposal.count({ where: { userId: owner.userId } })).toBe(before);
  });

  it("requires the PROPOSE scope and trusted product ids", async () => {
    const readOnly = await call(readToken, "POST", "/proposals", {
      mandateId,
      productId: "demo-headphones-139",
      source: "demo",
      quantity: 1,
    });
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe("SCOPE_MISSING");
    const unknown = await call(proposeToken, "POST", "/proposals", {
      mandateId,
      productId: "not-a-demo-product",
      source: "demo",
      quantity: 1,
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe("PRODUCT_NOT_TRUSTED");
    const external = await call(proposeToken, "POST", "/proposals", {
      mandateId,
      productId: "ch3-unknown-listing",
      source: "channel3",
      quantity: 1,
    });
    expect(external.json().code).toBe("PRODUCT_NOT_TRUSTED");
    const priced = await call(proposeToken, "POST", "/proposals", {
      mandateId,
      productId: "demo-headphones-139",
      source: "demo",
      quantity: 1,
      priceMinor: 1,
    });
    expect(priced.statusCode).toBe(400);
  });

  it("creates and evaluates a proposal through AgentGuard with the agent's identity", async () => {
    const response = await call(proposeToken, "POST", "/proposals", {
      mandateId,
      productId: "demo-headphones-139",
      source: "demo",
      quantity: 1,
      requestKey: `gateway-${runId}`,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.proposal).toMatchObject({
      totalMinor: 13_900,
      currency: "USD",
      status: "AUTHORIZED",
    });
    expect(body.decision).toMatchObject({ decision: "ALLOW" });
    expect(body.decision.explanation).toBeTruthy();
    // No AUTOPAY scope: the human completes checkout in MandatePay.
    expect(body.autopay).toMatchObject({ outcome: "NOT_ATTEMPTED", reason: "TOKEN_SCOPE_MISSING" });
    expect(body.nextStep).toMatchObject({
      action: "HUMAN_CHECKOUT",
      url: `${appUrl}/orders/new?proposalId=${body.proposal.id}`,
    });

    const selected = await database.auditEvent.findFirstOrThrow({
      where: { entityId: body.proposal.id, eventType: "PRODUCT_SELECTED" },
    });
    expect(selected.payload).toMatchObject({
      via: "agent-token",
      tokenId: proposeTokenId,
      tokenName: "Cursor agent",
    });
    const run = await database.agentRunMetric.findFirstOrThrow({
      where: { proposalId: body.proposal.id },
      include: { tools: true },
    });
    expect(run.modelId).toBe("external:cursor-agent");
    expect(run.tools.map((tool) => tool.name)).toEqual(["create_purchase_proposal"]);

    // The same retry key returns the same proposal, never a second one.
    const retried = await call(proposeToken, "POST", "/proposals", {
      mandateId,
      productId: "demo-headphones-139",
      source: "demo",
      quantity: 1,
      requestKey: `gateway-${runId}`,
    });
    expect(retried.json().proposal.id).toBe(body.proposal.id);

    const read = await call(readToken, "GET", `/proposals/${body.proposal.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json().decision.decision).toBe("ALLOW");
    expect((await call(strangerToken, "GET", `/proposals/${body.proposal.id}`)).statusCode).toBe(
      404,
    );
    expect((await call(readToken, "GET", `/orders/missing-payment`)).statusCode).toBe(404);
  });

  it("hands an AUTOPAY token's ALLOW proposal to the existing autopay service", async () => {
    const autopay = await createToken(
      owner.cookie,
      ["READ", "PROPOSE", "AUTOPAY"],
      "Autopay agent",
    );
    const response = await call(autopay.token, "POST", "/proposals", {
      mandateId,
      productId: "demo-headphones-139",
      source: "demo",
      quantity: 1,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.decision.decision).toBe("ALLOW");
    // No Vault-capable PayPal client here, so the service refuses without charging anything.
    expect(body.autopay).toMatchObject({ outcome: "NOT_ELIGIBLE", reason: "VAULT_UNAVAILABLE" });
    expect(body.autopay.paymentId).toBeNull();
    expect(await database.payment.count({ where: { proposalId: body.proposal.id } })).toBe(0);
    expect(body.nextStep.action).toBe("HUMAN_CHECKOUT");
  });

  it("returns AgentGuard's BLOCK for a mandate-excluded product and cannot be overridden", async () => {
    const response = await call(proposeToken, "POST", "/proposals", {
      mandateId,
      productId: "demo-headphones-refurbished",
      source: "demo",
      quantity: 1,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().decision.decision).toBe("BLOCK");
    expect(response.json().nextStep.action).toBe("NONE");
    for (const path of ["/approve", "/reject", "/autopay"]) {
      const attempt = await call(
        proposeToken,
        "POST",
        `/proposals/${response.json().proposal.id}${path}`,
        {},
      );
      expect(attempt.statusCode).toBe(404);
    }
    const foreign = await call(strangerToken, "POST", "/proposals", {
      mandateId,
      productId: "demo-headphones-139",
      source: "demo",
      quantity: 1,
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("respects the agent kill switches and maintenance mode", async () => {
    try {
      controlRows = [{ key: "agent.proposalCreationEnabled", valueJson: false }];
      const proposals = await call(proposeToken, "POST", "/proposals", {
        mandateId,
        productId: "demo-headphones-139",
        source: "demo",
        quantity: 1,
      });
      expect(proposals.statusCode).toBe(403);
      expect(proposals.json().code).toBe("AGENT_PROPOSALS_DISABLED");

      controlRows = [{ key: "platform.maintenanceMode", valueJson: true }];
      const maintenance = await call(proposeToken, "POST", "/proposals", {
        mandateId,
        productId: "demo-headphones-139",
        source: "demo",
        quantity: 1,
      });
      expect(maintenance.json().code).toBe("MAINTENANCE");

      controlRows = [{ key: "agent.enabled", valueJson: false }];
      const disabled = await call(readToken, "GET", "/mandates");
      expect(disabled.statusCode).toBe(403);
      expect(disabled.json().code).toBe("AGENT_DISABLED");

      controlRows = [{ key: "discovery.demoCatalogEnabled", valueJson: false }];
      const search = await call(readToken, "POST", "/products/search", { mandateId });
      expect(search.statusCode).toBe(403);
      expect(search.json().code).toBe("DEMO_CATALOG_DISABLED");
    } finally {
      controlRows = [];
    }
  });

  it("rejects revoked, expired and disabled-account tokens", async () => {
    const extra = await createToken(owner.cookie, ["READ"], "Short lived", 7);
    expect((await call(extra.token, "GET", "/mandates")).statusCode).toBe(200);
    const revoked = await server.inject({
      method: "POST",
      url: `/api/agent-tokens/${extra.agentToken.id}/revoke`,
      headers: { ...json, cookie: owner.cookie },
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().agentToken.status).toBe("REVOKED");
    const again = await server.inject({
      method: "POST",
      url: `/api/agent-tokens/${extra.agentToken.id}/revoke`,
      headers: { ...json, cookie: owner.cookie },
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(
      await database.auditEvent.count({
        where: { userId: owner.userId, eventType: "AGENT_TOKEN_REVOKED" },
      }),
    ).toBe(1);
    expect((await call(extra.token, "GET", "/mandates")).statusCode).toBe(401);
    const foreignRevoke = await server.inject({
      method: "POST",
      url: `/api/agent-tokens/${extra.agentToken.id}/revoke`,
      headers: { ...json, cookie: stranger.cookie },
      payload: {},
    });
    expect(foreignRevoke.statusCode).toBe(404);

    const expiring = await createToken(owner.cookie, ["READ"], "Expiring", 7);
    await database.agentAccessToken.update({
      where: { id: expiring.agentToken.id },
      data: {
        createdAt: new Date(Date.now() - 8 * 86_400_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const expired = await call(expiring.token, "GET", "/mandates");
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error).toMatch(/expired/u);

    const disabledUser = await signUp("disabled");
    const disabledToken = await createToken(disabledUser.cookie, ["READ"], "Disabled");
    await database.user.update({
      where: { id: disabledUser.userId },
      data: { disabledAt: new Date(), disabledReason: "Agent gateway integration test" },
    });
    const refused = await call(disabledToken.token, "GET", "/mandates");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("ACCOUNT_DISABLED");
  });

  it("limits each user to ten active tokens", async () => {
    const active = await database.agentAccessToken.count({
      where: { userId: stranger.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    for (let index = active; index < 10; index += 1) {
      await createToken(stranger.cookie, ["READ"], `Agent ${index}`, 7);
    }
    const over = await server.inject({
      method: "POST",
      url: "/api/agent-tokens",
      headers: { ...json, cookie: stranger.cookie },
      payload: { name: "One too many", scopes: ["READ"], expiresInDays: 7 },
    });
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe("TOKEN_LIMIT_REACHED");
  });
});
