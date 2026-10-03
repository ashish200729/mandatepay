import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";

const { createApp } = await import("./app.js");
const { createAuthRuntime } = await import("./auth.js");
const { createPrismaClient } = await import("@mandatepay/database");

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.APP_URL ?? "http://localhost:3000";
const authSecret = process.env.AUTH_SECRET;
const integrationSuite =
  testDatabaseUrl && authSecret && authSecret.length >= 32 ? describe : describe.skip;

const originHeaders = {
  origin: appUrl,
  "content-type": "application/json",
  accept: "application/json",
};

function cookieHeader(response: { headers: { "set-cookie"?: unknown } }) {
  const value = response.headers["set-cookie"];
  if (Array.isArray(value)) {
    return value
      .filter((cookie): cookie is string => typeof cookie === "string")
      .map((cookie) => cookie.split(";", 1)[0] ?? "")
      .join("; ");
  }
  return typeof value === "string" ? (value.split(";", 1)[0] ?? "") : "";
}

integrationSuite("Better Auth API", () => {
  const database = testDatabaseUrl ? createPrismaClient(testDatabaseUrl) : null;
  const runtime =
    database && authSecret
      ? createAuthRuntime({
          database,
          databaseUrl: testDatabaseUrl ?? "",
          authSecret,
          appUrl,
          nodeEnv: "test",
        })
      : null;
  let server: Awaited<ReturnType<typeof createApp>> | undefined;
  let userAEmail = "";
  let userBEmail = "";
  let userAId = "";
  let userBId = "";
  let cookieA = "";
  let cookieB = "";

  beforeAll(async () => {
    if (!runtime) return;
    server = await createApp({
      authRuntime: runtime,
      database: database ?? undefined,
      config: {
        HOST: "127.0.0.1",
        PORT: 4000,
        WEB_ORIGIN: appUrl,
        LOG_LEVEL: "silent",
        NODE_ENV: "test",
        APP_URL: appUrl,
        API_URL: "http://localhost:4000",
        DATABASE_URL: testDatabaseUrl ?? "",
        AUTH_SECRET: authSecret ?? "",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        PAYPAL_ENV: "sandbox",
        PRODUCT_DISCOVERY_MODE: "demo",
      },
    });
    userAEmail = "auth-a-" + Date.now() + "@mandatepay.local";
    userBEmail = "auth-b-" + Date.now() + "@mandatepay.local";
  });

  afterAll(async () => {
    await server?.close();
    await database?.$disconnect();
  });

  it("creates two users, returns sanitized principals, and protects anonymous access", async () => {
    if (!server) return;
    const ok = await server.inject({ method: "GET", url: "/api/auth/ok" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    const ready = await server.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);

    const anonymous = await server.inject({ method: "GET", url: "/api/me" });
    expect(anonymous.statusCode).toBe(401);

    const untrustedSignUp = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { ...originHeaders, origin: "https://evil.example" },
      payload: {
        name: "Rejected Origin",
        email: "rejected-" + Date.now() + "@mandatepay.local",
        password: "correct horse battery staple",
      },
    });
    expect(untrustedSignUp.statusCode).toBeGreaterThanOrEqual(400);

    const first = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: originHeaders,
      payload: {
        name: "Auth Test A",
        email: userAEmail,
        password: "correct horse battery staple",
      },
    });
    expect(first.statusCode).toBe(200);
    cookieA = cookieHeader(first);
    expect(cookieA).toContain("better-auth");
    expect(first.headers["set-cookie"]?.toString()).toMatch(/HttpOnly/i);
    expect(first.headers["set-cookie"]?.toString()).toMatch(/SameSite=Lax/i);

    const second = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: originHeaders,
      payload: {
        name: "Auth Test B",
        email: userBEmail,
        password: "correct horse battery staple",
      },
    });
    expect(second.statusCode).toBe(200);
    cookieB = cookieHeader(second);

    const meA = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookieA },
    });
    expect(meA.statusCode).toBe(200);
    expect(meA.json().user).toMatchObject({
      name: "Auth Test A",
      email: userAEmail,
      autonomousPurchasingEnabled: false,
    });
    expect(meA.json().user).not.toHaveProperty("password");
    expect(typeof meA.json().user.id).toBe("string");

    const meB = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookieB },
    });
    expect(meB.statusCode).toBe(200);
    expect(meB.json().user.email).toBe(userBEmail);
    userAId = meA.json().user.id;
    userBId = meB.json().user.id;
  });

  it("enforces CSRF origin checks and audits only actual setting changes", async () => {
    if (!server) return;
    const untrusted = await server.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { ...originHeaders, cookie: cookieA, origin: "https://evil.example" },
      payload: { autonomousPurchasingEnabled: true },
    });
    expect(untrusted.statusCode).toBe(403);

    const invalid = await server.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { ...originHeaders, cookie: cookieA },
      payload: { autonomousPurchasingEnabled: true, userId: userBId },
    });
    expect(invalid.statusCode).toBe(400);

    const update = await server.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { ...originHeaders, cookie: cookieA },
      payload: { autonomousPurchasingEnabled: true },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      changed: true,
      user: { id: userAId, autonomousPurchasingEnabled: true },
    });

    const repeat = await server.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { ...originHeaders, cookie: cookieA },
      payload: { autonomousPurchasingEnabled: true },
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().changed).toBe(false);

    const unaffected = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookieB },
    });
    expect(unaffected.statusCode).toBe(200);
    expect(unaffected.json().user).toMatchObject({
      id: userBId,
      autonomousPurchasingEnabled: false,
    });

    const audit = await database?.auditEvent.findMany({
      where: { userId: userAId, eventType: "GLOBAL_AUTONOMY_UPDATED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("rejects tampered sessions, signs in again, and logs out", async () => {
    if (!server) return;
    const tampered = cookieA.replace(/.$/, (character) => (character === "a" ? "b" : "a"));
    const invalidSession = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: tampered },
    });
    expect(invalidSession.statusCode).toBe(401);

    const logout = await server.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { ...originHeaders, cookie: cookieA },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookieA },
    });
    expect(afterLogout.statusCode).toBe(401);

    const login = await server.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: originHeaders,
      payload: {
        email: userAEmail,
        password: "correct horse battery staple",
      },
    });
    expect(login.statusCode).toBe(200);
    const newCookie = cookieHeader(login);
    expect(newCookie).toContain("better-auth");

    const afterLogin = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: newCookie },
    });
    expect(afterLogin.statusCode).toBe(200);
    expect(afterLogin.json().user.id).toBe(userAId);
  });

  it("gates existing unverified sessions when verification is enabled", async () => {
    if (!runtime || !database) throw new Error("Missing isolated auth runtime");
    const gated = await createApp({ authRuntime: { ...runtime, requireEmailVerification: true } });
    try {
      const blocked = await gated.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: cookieB },
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().code).toBe("EMAIL_NOT_VERIFIED");
      expect(
        (await gated.inject({ method: "GET", url: "/api/orders", headers: { cookie: cookieB } }))
          .statusCode,
      ).toBe(403);
      await database.user.update({ where: { id: userBId }, data: { emailVerified: true } });
      expect(
        (await gated.inject({ method: "GET", url: "/api/me", headers: { cookie: cookieB } }))
          .statusCode,
      ).toBe(200);
    } finally {
      await gated.close();
    }
  });
});
