import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, AdminRepository } from "@mandatepay/database";
import { createAuthRuntime } from "./auth.js";
import { createApp } from "./app.js";
import {
  ADMIN_FRESH_MS,
  ADMIN_IDLE_MS,
  requireFreshAdminAuth,
} from "./modules/admin/admin.auth.js";

const database = createPrismaClient(process.env.TEST_DATABASE_URL);
const origin = "http://localhost:3001";
const password = "admin-fixture-password-123!";
const runtime = createAuthRuntime({
  database,
  databaseUrl: process.env.TEST_DATABASE_URL!,
  authSecret: process.env.AUTH_SECRET!,
  appUrl: "http://localhost:3000",
  adminOrigin: origin,
  nodeEnv: "test",
});
const config = {
  HOST: "127.0.0.1",
  PORT: 4000,
  WEB_ORIGIN: "http://localhost:3000",
  LOG_LEVEL: "silent" as const,
  NODE_ENV: "test" as const,
  APP_URL: "http://localhost:3000",
  API_URL: "http://localhost:4000",
  ADMIN_ORIGIN: origin,
  DATABASE_URL: process.env.TEST_DATABASE_URL!,
  AUTH_SECRET: process.env.AUTH_SECRET!,
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  PAYPAL_ENV: "sandbox" as const,
  PRODUCT_DISCOVERY_MODE: "demo" as const,
};
let app: Awaited<ReturnType<typeof createApp>>;
let adminId = "",
  normalId = "",
  unverifiedId = "",
  principalId = "";
let adminEmail = "",
  normalEmail = "",
  unverifiedEmail = "";
let cookie = "",
  sessionId = "",
  webAdminCookie = "",
  normalCookie = "";
let sequence = 1;
function cookies(response: { headers: { "set-cookie"?: unknown } }) {
  const raw = response.headers["set-cookie"];
  return (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
    .map((v) => String(v).split(";", 1)[0])
    .join("; ");
}
function post(url: string, payload: unknown, sessionCookie?: string, ip?: string) {
  return app.inject({
    method: "POST",
    url,
    payload: JSON.stringify(payload),
    remoteAddress: ip ?? `10.42.0.${sequence++}`,
    headers: {
      origin,
      "content-type": "application/json",
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
    },
  });
}
async function login() {
  const response = await post("/api/admin/session", { email: adminEmail, password });
  expect(response.statusCode, response.body).toBe(200);
  cookie = cookies(response);
  const row = await database.session.findFirstOrThrow({
    where: { userId: adminId, adminSecurity: { isNot: null } },
    orderBy: { createdAt: "desc" },
  });
  sessionId = row.id;
  return response;
}

describe("admin security with persisted Better Auth sessions", () => {
  beforeAll(async () => {
    if (await database.adminPrincipal.count())
      throw new Error(
        "Admin integration requires no existing principal in the isolated test database.",
      );
    app = await createApp({ config, authRuntime: runtime });
    for (const [kind, verified] of [
      ["admin", true],
      ["normal", true],
      ["unverified", false],
    ] as const) {
      const email = `admin-security-${kind}-${Date.now()}@mandatepay.local`;
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        payload: { email, password, name: kind },
        headers: { origin: config.APP_URL, "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(200);
      const user = response.json().user as { id: string };
      if (verified)
        await database.user.update({ where: { id: user.id }, data: { emailVerified: true } });
      if (kind === "admin") {
        adminId = user.id;
        adminEmail = email;
        webAdminCookie = cookies(response);
      }
      if (kind === "normal") {
        normalId = user.id;
        normalEmail = email;
        normalCookie = cookies(response);
      }
      if (kind === "unverified") {
        unverifiedId = user.id;
        unverifiedEmail = email;
      }
    }
  });
  afterAll(async () => {
    await app?.close();
    await database.adminPrincipal.deleteMany({ where: { userId: adminId || "missing" } });
    await database.user.deleteMany({
      where: { id: { in: [adminId, normalId, unverifiedId].filter(Boolean) } },
    });
    await database.$disconnect();
  });

  it("requires a verified existing identity and bootstraps the singleton idempotently under concurrent requests", async () => {
    const repository = new AdminRepository(database);
    await expect(repository.bootstrap("missing-user")).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expect(repository.bootstrap(unverifiedId)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    const result = await Promise.all([
      repository.bootstrap(adminId),
      repository.bootstrap(adminId),
    ]);
    expect(result.filter((v) => v.created)).toHaveLength(1);
    expect(result[0]!.principal.id).toBe(result[1]!.principal.id);
    principalId = result[0]!.principal.id;
    await expect(repository.bootstrap(normalId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      database.adminPrincipal.create({ data: { userId: normalId, singletonKey: "main" } }),
    ).rejects.toBeDefined();
    await expect(
      database.adminPrincipal.create({ data: { userId: normalId, singletonKey: "next" } }),
    ).rejects.toBeDefined();
    expect(await database.adminPrincipal.count()).toBe(1);
  });

  it("rejects anonymous, normal-user and ordinary web-admin sessions, including unknown admin routes", async () => {
    for (const url of ["/api/admin/me", "/api/admin/not-implemented"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: "GET", url, headers: { cookie: normalCookie } })).statusCode,
      ).toBe(403);
    }
    const web = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      headers: { cookie: webAdminCookie },
    });
    expect(web.statusCode).toBe(401);
    expect(web.json().error.code).toBe("ADMIN_UNAUTHORIZED");
    expect(web.headers["cache-control"]).toBe("private, no-store");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/admin/me",
          headers: {
            cookie: "better-auth.session_token=forged",
            "x-mandatepay-admin-authorized": "true",
          },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("rejects non-admin and unverified credentials without exposing a cookie/token or retaining their new session", async () => {
    for (const [email, id] of [
      [normalEmail, normalId],
      [unverifiedEmail, unverifiedId],
    ]) {
      const count = await database.session.count({ where: { userId: id } });
      const response = await post("/api/admin/session", { email, password });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("ADMIN_SIGN_IN_REJECTED");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.body).not.toMatch(/password|session_token|"token"|stack/u);
      expect(await database.session.count({ where: { userId: id } })).toBe(count);
    }
    expect(
      (await post("/api/admin/session", { email: adminEmail, password: "invalid" })).statusCode,
    ).toBe(401);
    expect(
      (await post("/api/admin/session", { email: adminEmail, password, role: "ADMIN_SUPER" }))
        .statusCode,
    ).toBe(400);
  });

  it("returns only a safe active-admin principal and secure cookie metadata", async () => {
    const response = await login();
    expect(cookie).toContain("better-auth");
    expect(String(response.headers["set-cookie"])).toMatch(/HttpOnly/u);
    expect(String(response.headers["set-cookie"])).toMatch(/SameSite=Lax/u);
    const me = await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.principal).toEqual({ id: principalId, role: "ADMIN_SUPER" });
    expect(me.json().data.user.emailVerified).toBe(true);
    expect(me.body).not.toMatch(/"token"|password|ipAddress|userAgent|sessionId/u);
    expect(response.body).not.toContain(password);
    await expect(requireFreshAdminAuth(runtime, { headers: { cookie } })).resolves.toMatchObject({
      principalId,
    });
  });

  it("immediately denies inactive or newly unverified admins and does not reactivate through bootstrap", async () => {
    await database.adminPrincipal.update({ where: { id: principalId }, data: { active: false } });
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } })).statusCode,
    ).toBe(403);
    expect((await post("/api/admin/session", { email: adminEmail, password })).statusCode).toBe(
      401,
    );
    expect((await new AdminRepository(database).bootstrap(adminId)).principal.active).toBe(false);
    await database.adminPrincipal.update({ where: { id: principalId }, data: { active: true } });
    await database.user.update({ where: { id: adminId }, data: { emailVerified: false } });
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } })).statusCode,
    ).toBe(403);
    await database.user.update({ where: { id: adminId }, data: { emailVerified: true } });
  });

  it("distinguishes stale fresh-auth from an otherwise valid session and rotates/revokes proof after credential reauth", async () => {
    await database.adminSessionSecurity.update({
      where: { sessionId },
      data: { reauthenticatedAt: new Date(Date.now() - ADMIN_FRESH_MS) },
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } })).statusCode,
    ).toBe(200);
    await expect(requireFreshAdminAuth(runtime, { headers: { cookie } })).rejects.toMatchObject({
      code: "ADMIN_REAUTH_REQUIRED",
      status: 403,
    });
    const oldCookie = cookie,
      oldSessionId = sessionId;
    expect((await post("/api/admin/reauth", { password: "wrong" }, cookie)).statusCode).toBe(401);
    expect(
      (await post("/api/admin/reauth", { password, freshAuth: true }, cookie)).statusCode,
    ).toBe(400);
    const response = await post("/api/admin/reauth", { password }, cookie);
    expect(response.statusCode, response.body).toBe(200);
    cookie = cookies(response);
    sessionId = (
      await database.session.findFirstOrThrow({
        where: { userId: adminId, adminSecurity: { isNot: null } },
        orderBy: { createdAt: "desc" },
      })
    ).id;
    expect(sessionId).not.toBe(oldSessionId);
    expect(
      await database.adminSessionSecurity.findUnique({ where: { sessionId: oldSessionId } }),
    ).toBeNull();
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: oldCookie } }))
        .statusCode,
    ).toBe(401);
    await expect(requireFreshAdminAuth(runtime, { headers: { cookie } })).resolves.toMatchObject({
      principalId,
    });
  });

  it("rejects an elapsed idle deadline without reviving it through concurrent reads or reauth", async () => {
    await database.adminSessionSecurity.update({
      where: { sessionId },
      data: { lastSeenAt: new Date(Date.now() - ADMIN_IDLE_MS) },
    });
    const responses = await Promise.all(
      [0, 1].map(() => app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } })),
    );
    expect(responses.map((v) => v.statusCode)).toEqual([401, 401]);
    expect((await post("/api/admin/reauth", { password }, cookie)).statusCode).toBe(401);
    await login();
  });

  it("requires exact admin origin, rejects customer origin/forged hosts and limits auth separately", async () => {
    for (const badOrigin of [config.APP_URL, "https://evil.example", origin + "/path"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/sign-out",
        payload: {},
        headers: {
          origin: badOrigin,
          host: "localhost:3001",
          "content-type": "application/json",
          cookie,
        },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/session",
          payload: { email: adminEmail, password },
        })
      ).statusCode,
    ).toBe(403);
    const alias = await app.inject({
      method: "OPTIONS",
      url: "/api/admin/session",
      headers: { origin: "http://127.0.0.1:3001", "access-control-request-method": "POST" },
    });
    expect(alias.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3001");
    for (let i = 0; i < 5; i++)
      expect([401, 429]).toContain(
        (
          await post(
            "/api/admin/session",
            { email: adminEmail, password: "wrong" },
            undefined,
            "10.60.0.1",
          )
        ).statusCode,
      );
    const limited = await post(
      "/api/admin/session",
      { email: adminEmail, password },
      undefined,
      "10.60.0.1",
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } })).statusCode,
    ).toBe(200);
  });

  it("enforces principal-scoped read limits and keeps sign-out available through a separate bucket", async () => {
    const responses = [];
    for (let i = 0; i < 120; i++)
      responses.push(
        await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } }),
      );
    expect(responses.some((v) => v.statusCode === 429)).toBe(true);
    const response = await post("/api/admin/sign-out", {}, cookie);
    expect(response.statusCode).toBe(204);
    expect(await database.session.findUnique({ where: { id: sessionId } })).toBeNull();
    expect(await database.adminSessionSecurity.findUnique({ where: { sessionId } })).toBeNull();
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it("fails closed when auth or admin-origin configuration is absent", async () => {
    const unavailable = await createApp({ config, authRuntime: null });
    expect((await unavailable.inject({ method: "GET", url: "/api/admin/me" })).statusCode).toBe(
      503,
    );
    await unavailable.close();
    const unconfigured = await createApp({
      config: { ...config, ADMIN_ORIGIN: undefined },
      authRuntime: runtime,
    });
    expect(
      (
        await unconfigured.inject({
          method: "POST",
          url: "/api/admin/session",
          payload: { email: adminEmail, password },
          headers: { origin, "content-type": "application/json" },
        })
      ).statusCode,
    ).toBe(503);
    await unconfigured.close();
  });
});
