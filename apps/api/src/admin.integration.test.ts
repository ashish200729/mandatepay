import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createPrismaClient,
  AdminRepository,
  AdminAuditRepository,
  AdminActionRepository,
  MandateRepository,
  ProposalRepository,
  MandateStatus,
  MandateRuleType,
  RuleOperator,
  ProductCondition,
  PolicyDecisionType,
} from "@mandatepay/database";
import type { PayPalCapture, PayPalClient, PayPalOrder, PayPalRefund } from "@mandatepay/paypal";
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
const getOrder = vi.fn<(id: string) => Promise<PayPalOrder>>();
const getCapture = vi.fn<(id: string) => Promise<PayPalCapture>>();
const getRefund = vi.fn<(id: string) => Promise<PayPalRefund>>();
const refundCapture = vi.fn<(input: unknown) => Promise<PayPalRefund>>();
const paypalClient = {
  getOrder,
  getCapture,
  getRefund,
  refundCapture,
  config: { webhookId: "admin-test-webhook" },
} as unknown as PayPalClient;
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
    app = await createApp({
      config,
      authRuntime: runtime,
      testAdminMutationMaximum: 100,
      testAdminFinancialMaximum: 50,
      paypalClient,
    });
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
    const owners = [adminId, normalId, unverifiedId].filter(Boolean);
    await database.adminActionRequest.deleteMany({
      where: { principalId: principalId || "missing" },
    });
    await database.adminPrincipal.deleteMany({ where: { userId: adminId || "missing" } });
    await database.refund.deleteMany({ where: { userId: { in: owners } } });
    await database.webhookInbox.deleteMany({
      where: { providerEventId: { startsWith: "admin-ops-" } },
    });
    await database.payment.deleteMany({ where: { userId: { in: owners } } });
    await database.approval.deleteMany({ where: { userId: { in: owners } } });
    await database.spendReservation.deleteMany({
      where: { mandate: { userId: { in: owners } } },
    });
    await database.session.deleteMany({ where: { userId: { in: owners } } });
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

  it("searches safe session events while denying anonymous/non-admin audit access", async () => {
    const url = `/api/admin/audit?actorAdminId=${principalId}&action=ADMIN_LOGIN_SUCCEEDED&result=SUCCESS`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url, headers: { cookie: normalCookie } })).statusCode,
    ).toBe(403);
    const correlationId = randomUUID();
    const response = await app.inject({
      method: "GET",
      url,
      headers: { cookie, "x-correlation-id": correlationId, "x-request-id": "untrusted" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe(correlationId);
    expect(response.headers["x-request-id"]).toBe(response.json().requestId);
    expect(response.json().requestId).not.toBe("untrusted");
    const row = response.json().data[0];
    expect(row.actorAdminId).toBe(principalId);
    expect(row.actorUserId).toBe(adminId);
    expect(row.action).toBe("ADMIN_LOGIN_SUCCEEDED");
    expect(row.result).toBe("SUCCESS");
    expect(response.body).not.toContain(password);
    expect(response.body).not.toContain(adminEmail);
    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/audit/${row.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data).toEqual(row);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/audit/${randomUUID()}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    const failed = await app.inject({
      method: "GET",
      url: "/api/admin/audit?action=ADMIN_LOGIN_FAILED&result=FAILURE",
      headers: { cookie },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().data.length).toBeGreaterThan(0);
    for (const failure of failed.json().data)
      expect(failure).toMatchObject({
        actorAdminId: null,
        actorUserId: null,
        role: null,
        targetId: "main",
      });
    expect(failed.body).not.toContain(normalEmail);
    expect(failed.headers["cache-control"]).toBe("private, no-store");
  });

  it("paginates without duplicates, binds cursors to filters and uses half-open UTC dates", async () => {
    const correlationId = randomUUID();
    const actor = { principalId, userId: adminId, role: "ADMIN_SUPER" as const };
    const rows = await database.$transaction(async (tx) =>
      Promise.all(
        [0, 1, 2].map(() =>
          new AdminAuditRepository(tx).append({
            actor,
            action: "ADMIN_NOTE_ADDED",
            targetType: "USER",
            targetId: normalId,
            reason: "Reviewing fixture case.",
            requestId: randomUUID(),
            correlationId,
            result: "SUCCESS",
            beforeSummaryJson: { password: "never-stored" },
            afterSummaryJson: { emailVerified: true, token: "never-stored" },
          }),
        ),
      ),
    );
    const base = `/api/admin/audit?correlationId=${correlationId}&targetType=USER&targetId=${normalId}&action=ADMIN_NOTE_ADDED&result=SUCCESS&limit=2`;
    const first = await app.inject({ method: "GET", url: base, headers: { cookie } });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toHaveLength(2);
    const cursor = first.json().page.nextCursor;
    expect(typeof cursor).toBe("string");
    const second = await app.inject({
      method: "GET",
      url: base + "&cursor=" + encodeURIComponent(cursor),
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().page.nextCursor).toBeNull();
    expect(
      new Set([...first.json().data, ...second.json().data].map((row: { id: string }) => row.id))
        .size,
    ).toBe(3);
    expect(first.body + second.body).not.toMatch(/never-stored|"password"|"token"/u);
    for (const badUrl of [
      base + "&cursor=" + cursor.slice(0, -4),
      base.replace("limit=2", "limit=1") + "&cursor=" + encodeURIComponent(cursor),
      "/api/admin/audit?limit=101",
      "/api/admin/audit?action=INVALID",
      "/api/admin/audit?secret=private",
      "/api/admin/audit?from=2026-10-05T00:00:00Z",
    ])
      expect(
        (await app.inject({ method: "GET", url: badUrl, headers: { cookie } })).statusCode,
      ).toBe(400);
    const cutoff = rows[0]!.createdAt;
    const range = `/api/admin/audit?correlationId=${correlationId}&from=${encodeURIComponent(cutoff)}&to=${encodeURIComponent(new Date(Date.parse(cutoff) + 1).toISOString())}`;
    const ranged = await app.inject({ method: "GET", url: range, headers: { cookie } });
    expect(ranged.statusCode).toBe(200);
    expect(ranged.json().data.some((row: { id: string }) => row.id === rows[0]!.id)).toBe(true);
    const excluded = await app.inject({
      method: "GET",
      url: `/api/admin/audit?correlationId=${correlationId}&from=${encodeURIComponent(new Date(Date.parse(cutoff) - 86400_000).toISOString())}&to=${encodeURIComponent(cutoff)}`,
      headers: { cookie },
    });
    expect(excluded.json().data.some((row: { id: string }) => row.id === rows[0]!.id)).toBe(false);
  });

  it("rejects audit updates/deletes/truncation and has no public write API", async () => {
    const repository = new AdminAuditRepository(database);
    expect("update" in repository || "delete" in repository).toBe(false);
    const row = await repository.append({
      actor: { principalId, userId: adminId, role: "ADMIN_SUPER" },
      action: "ADMIN_NOTE_ADDED",
      targetType: "USER",
      targetId: normalId,
      reason: "Immutable fixture event.",
      requestId: randomUUID(),
      correlationId: randomUUID(),
      result: "SUCCESS",
    });
    await expect(
      database.adminAuditEvent.update({ where: { id: row.id }, data: { reason: "Changed" } }),
    ).rejects.toBeDefined();
    await expect(database.adminAuditEvent.delete({ where: { id: row.id } })).rejects.toBeDefined();
    await expect(
      database.$executeRaw`UPDATE "AdminAuditEvent" SET reason = 'Changed' WHERE id = ${row.id}`,
    ).rejects.toBeDefined();
    await expect(database.$executeRaw`TRUNCATE TABLE "AdminAuditEvent"`).rejects.toBeDefined();
    expect(await repository.findById(row.id)).toEqual(row);
    for (const method of ["POST", "PATCH", "DELETE"] as const)
      expect(
        (
          await app.inject({
            method,
            url: `/api/admin/audit/${row.id}`,
            headers: { origin, cookie, "content-type": "application/json" },
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
  });

  it("commits local state and audit atomically, rejecting unsafe reasons and rolling back both on failure", async () => {
    const before = (await database.user.findUniqueOrThrow({ where: { id: normalId } }))
      .globalAutonomousPurchasingEnabled;
    const event = {
      actor: { principalId, userId: adminId, role: "ADMIN_SUPER" as const },
      action: "ADMIN_AUTONOMY_DISABLED" as const,
      targetType: "USER" as const,
      targetId: normalId,
      reason: "Investigating fixture case.",
      requestId: randomUUID(),
      correlationId: randomUUID(),
      result: "SUCCESS" as const,
      afterSummaryJson: { autonomousPurchasingEnabled: false },
    };
    await expect(
      database.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: normalId },
          data: { globalAutonomousPurchasingEnabled: !before },
        });
        await new AdminAuditRepository(tx).append({ ...event, reason: "password=do-not-store" });
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOMAIN_INPUT" });
    expect(
      (await database.user.findUniqueOrThrow({ where: { id: normalId } }))
        .globalAutonomousPurchasingEnabled,
    ).toBe(before);
    await expect(
      database.$transaction(async (tx) => {
        await new AdminAuditRepository(tx).append(event);
        throw new Error("Rollback fixture");
      }),
    ).rejects.toThrow("Rollback fixture");
    expect(
      await database.adminAuditEvent.count({ where: { correlationId: event.correlationId } }),
    ).toBe(0);
    await database.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: normalId },
        data: { globalAutonomousPurchasingEnabled: false },
      });
      await new AdminAuditRepository(tx).append(event);
    });
    expect(
      await database.adminAuditEvent.count({ where: { correlationId: event.correlationId } }),
    ).toBe(1);
  });

  it("claims one durable action concurrently and correlates idempotent pending/terminal outcomes", async () => {
    const repository = new AdminActionRepository(database);
    const actor = { principalId, userId: adminId, role: "ADMIN_SUPER" as const };
    const input = {
      actor,
      action: "ADMIN_PAYMENT_RECONCILE_REQUESTED" as const,
      targetType: "PAYMENT" as const,
      targetId: "fixture-payment",
      reason: "Reconcile fixture state.",
      requestId: randomUUID(),
      correlationId: randomUUID(),
      requestKey: randomUUID(),
      beforeSummaryJson: { status: "CAPTURE_PENDING" },
      requestSummaryJson: { status: "CAPTURE_PENDING" },
    };
    const claims = await Promise.all([repository.claim(input), repository.claim(input)]);
    expect(claims.filter((claim) => claim.created)).toHaveLength(1);
    expect(claims[0]!.actionId).toBe(claims[1]!.actionId);
    await expect(repository.claim({ ...input, reason: "Different reason." })).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
    await expect(
      repository.claim({ ...input, targetId: "different-target" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      repository.claim({ ...input, requestSummaryJson: { status: "COMPLETED" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const actionId = claims[0]!.actionId;
    await expect(
      repository.recordOutcome(actionId, {
        actor,
        requestId: randomUUID(),
        correlationId: randomUUID(),
        result: "PENDING",
        errorCode: "PROVIDER_PENDING",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const pending = await repository.recordOutcome(actionId, {
      actor,
      requestId: randomUUID(),
      correlationId: input.correlationId,
      result: "PENDING",
      errorCode: "PROVIDER_PENDING",
    });
    expect(pending.status).toBe("PENDING");
    const outcome = {
      actor,
      requestId: randomUUID(),
      correlationId: input.correlationId,
      result: "SUCCESS" as const,
      afterSummaryJson: { status: "COMPLETED", amountMinor: 100, currency: "USD" },
    };
    expect((await repository.recordOutcome(actionId, outcome)).changed).toBe(true);
    expect((await repository.recordOutcome(actionId, outcome)).changed).toBe(false);
    await expect(
      repository.recordOutcome(actionId, {
        ...outcome,
        result: "FAILURE",
        errorCode: "PROVIDER_UNAVAILABLE",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const events = await database.adminAuditEvent.findMany({ where: { actionId } });
    expect(events).toHaveLength(3);
    expect(events.filter((event) => event.result === "SUCCESS")).toHaveLength(1);
    expect(
      (await database.adminActionRequest.findUniqueOrThrow({ where: { id: actionId } })).status,
    ).toBe("COMPLETED");
  });

  it("fails closed on audit persistence failure without granting/rotating/revoking a session", async () => {
    const originalCookie = cookie;
    for (const path of ["session", "reauth", "sign-out"]) {
      const spy = vi
        .spyOn(AdminAuditRepository.prototype, "append")
        .mockRejectedValueOnce(new Error("private-audit-provider-detail"));
      try {
        const count = await database.session.count({ where: { userId: adminId } });
        const response = await post(
          `/api/admin/${path}`,
          path === "session"
            ? { email: adminEmail, password }
            : path === "reauth"
              ? { password }
              : {},
          originalCookie,
        );
        expect(response.statusCode, response.body).toBe(503);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(response.body).not.toContain("private-audit-provider-detail");
        expect(await database.session.count({ where: { userId: adminId } })).toBe(count);
        expect(
          (
            await app.inject({
              method: "GET",
              url: "/api/admin/me",
              headers: { cookie: originalCookie },
            })
          ).statusCode,
        ).toBe(200);
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("exposes the read-only operations chain without provider payloads or sample records", async () => {
    await database.user.update({ where: { id: normalId }, data: { name: "=SUM(1)" } });
    const prompt = "secret-original-prompt-must-not-render";
    const mandate = await new MandateRepository(database).create({
      userId: normalId,
      title: "Admin operations headphones",
      originalPrompt: prompt,
      status: MandateStatus.ACTIVE,
      autoSpendLimit: 15_000n,
      transactionLimit: 18_000n,
      dailyLimit: 20_000n,
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 86_400_000),
      rules: [
        { ruleType: MandateRuleType.ALLOWED_BRAND, operator: RuleOperator.IN, value: ["Sony"] },
      ],
    });
    const product = await database.productSnapshot.create({
      data: {
        source: "admin-ops-test",
        externalId: `headphones-${randomUUID()}`,
        title: "Operations headphones",
        brand: "Sony",
        category: "headphones",
        condition: ProductCondition.NEW,
        price: 10_000n,
        currency: "USD",
        merchant: "Test merchant",
        metadata: { token: "never-store" },
      },
    });
    const proposal = await new ProposalRepository(database).create({
      userId: normalId,
      mandateId: mandate.id,
      mandateVersionId: mandate.activeVersionId ?? "",
      productSnapshotId: product.id,
      quantity: 1,
      shipping: 0n,
      tax: 0n,
      idempotencyKey: `admin-ops-proposal-${randomUUID()}`,
    });
    await database.policyDecision.create({
      data: {
        proposalId: proposal.id,
        mandateVersionId: mandate.activeVersionId ?? "",
        decision: PolicyDecisionType.REQUIRE_APPROVAL,
        reasonCodes: ["AUTO_SPEND_THRESHOLD_EXCEEDED"],
        rulesSnapshot: {},
        spendSnapshot: {},
      },
    });
    const approval = await database.approval.create({
      data: {
        proposalId: proposal.id,
        userId: normalId,
        decision: "APPROVED",
        proposalFingerprint: proposal.proposalFingerprint,
        expiresAt: new Date(Date.now() + 86_400_000),
        decidedAt: new Date(),
      },
    });
    const paypalOrderId = `ORDER-ADMIN-OPS-${randomUUID()}`;
    const paypalCaptureId = `CAPTURE-ADMIN-OPS-${randomUUID()}`;
    const payment = await database.payment.create({
      data: {
        userId: normalId,
        mandateId: mandate.id,
        proposalId: proposal.id,
        paypalOrderId,
        paypalCaptureId,
        amount: 10_000n,
        currency: "USD",
        status: "PARTIALLY_REFUNDED",
        idempotencyKey: `admin-ops-payment-${randomUUID()}`,
        capturedAt: new Date(),
      },
    });
    await database.purchaseProposal.update({
      where: { id: proposal.id },
      data: { status: "COMPLETED" },
    });
    const refund = await database.refund.create({
      data: {
        paymentId: payment.id,
        userId: normalId,
        amount: 2_000n,
        currency: "USD",
        status: "COMPLETED",
        paypalRefundId: `REFUND-ADMIN-OPS-${randomUUID()}`,
        idempotencyKey: `admin-ops-refund-${randomUUID()}`,
        settledAt: new Date(),
        reason: "Partial customer return.",
      },
    });
    const sampleProposal = await new ProposalRepository(database).create({
      userId: normalId,
      mandateId: mandate.id,
      mandateVersionId: mandate.activeVersionId ?? "",
      productSnapshotId: product.id,
      quantity: 1,
      shipping: 0n,
      tax: 0n,
      idempotencyKey: `admin-ops-sample-${randomUUID()}`,
    });
    await database.purchaseProposal.update({
      where: { id: sampleProposal.id },
      data: { isSample: true },
    });
    const samplePayment = await database.payment.create({
      data: {
        userId: normalId,
        mandateId: mandate.id,
        proposalId: sampleProposal.id,
        paypalOrderId: `ORDER-SAMPLE-${randomUUID()}`,
        amount: 10_000n,
        currency: "USD",
        status: "COMPLETED",
        isSample: true,
        idempotencyKey: `admin-ops-sample-payment-${randomUUID()}`,
        capturedAt: new Date(),
      },
    });
    const webhook = await database.webhookInbox.create({
      data: {
        provider: "paypal",
        providerEventId: `admin-ops-${randomUUID()}`,
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        signatureVerified: true,
        payload: {
          resource: {
            id: paypalCaptureId,
            supplementary_data: { related_ids: { order_id: paypalOrderId } },
            secret: "webhook-secret-must-not-render",
          },
        },
        status: "PROCESSED",
        attempts: 1,
        processedAt: new Date(),
        lastError: null,
      },
    });
    await database.auditEvent.create({
      data: {
        userId: normalId,
        eventType: "PAYMENT_CAPTURED",
        entityType: "PAYMENT",
        entityId: payment.id,
        payload: { amountMinor: 10000, token: "never-store" },
      },
    });

    const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
    const getOk = async (url: string) => {
      const response = await get(url);
      expect(response.statusCode, response.body).toBe(200);
      return response;
    };
    expect((await get("/api/admin/not-a-resource")).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/payments",
          headers: { origin, cookie, "content-type": "application/json" },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect((await get("/api/admin/users?secret=private")).statusCode).toBe(400);
    expect((await get("/api/admin/users?limit=101")).statusCode).toBe(400);

    const overview = await getOk("/api/admin/overview");
    expect(overview.json().data.metrics.totalUsers.availability).toBe("available");
    expect(overview.json().data.metrics.agentRequests.availability).toBe("unavailable");
    expect(overview.json().data.metrics.agentRequests.value).toBeNull();
    expect(overview.body).not.toContain(prompt);

    const users = await getOk(`/api/admin/users?q=${encodeURIComponent(normalEmail)}&limit=10`);
    expect(users.json().data.some((row: { id: string }) => row.id === normalId)).toBe(true);
    const user = await getOk(`/api/admin/users/${normalId}`);
    expect(user.json().data.capturedGrossMinor).toBe(10000);
    expect(user.json().data.accessStatus).toBe("enabled");
    expect(user.body).not.toMatch(/password|"token"/u);

    const mandateDetail = await getOk(`/api/admin/mandates/${mandate.id}`);
    expect(mandateDetail.json().data.owner.id).toBe(normalId);
    expect(mandateDetail.body).not.toContain(prompt);
    expect(mandateDetail.body).not.toContain("originalPrompt");

    const proposalDetail = await getOk(`/api/admin/proposals/${proposal.id}`);
    expect(proposalDetail.json().data.mandateId).toBe(mandate.id);
    expect(proposalDetail.json().data.latestDecision.decision).toBe("REQUIRE_APPROVAL");
    expect(proposalDetail.json().data.approvalId).toBe(approval.id);
    expect(proposalDetail.json().data.paymentId).toBe(payment.id);
    const reservation = await getOk(`/api/admin/proposals/${proposal.id}/reservation`);
    expect(reservation.json().data).toBeNull();

    const samples = await getOk("/api/admin/proposals?limit=50");
    expect(samples.json().data.some((row: { id: string }) => row.id === sampleProposal.id)).toBe(
      false,
    );
    const withSamples = await getOk("/api/admin/proposals?includeSamples=true&limit=50");
    expect(
      withSamples.json().data.some((row: { id: string }) => row.id === sampleProposal.id),
    ).toBe(true);

    const approvalDetail = await getOk(`/api/admin/approvals/${approval.id}`);
    expect(approvalDetail.json().data.proposalId).toBe(proposal.id);
    const order = await getOk(`/api/admin/orders/${payment.id}`);
    expect(order.json().data.paypalOrderId).toBe(paypalOrderId);
    const paymentDetail = await getOk(`/api/admin/payments/${payment.id}`);
    expect(paymentDetail.json().data.mandateId).toBe(mandate.id);
    expect(paymentDetail.json().data.refundState).toBe("refunded");
    expect((await get(`/api/admin/orders/${samplePayment.id}`)).statusCode).toBe(200);
    const defaultPayments = await getOk(`/api/admin/payments?userId=${normalId}&limit=50`);
    expect(
      defaultPayments.json().data.some((row: { id: string }) => row.id === samplePayment.id),
    ).toBe(false);
    const refundDetail = await getOk(`/api/admin/refunds/${refund.id}`);
    expect(refundDetail.json().data.paymentId).toBe(payment.id);
    expect(refundDetail.json().data.kind).toBe("PARTIAL");

    const webhookDetail = await getOk(`/api/admin/webhooks/${webhook.id}`);
    expect(webhookDetail.json().data.paymentId).toBe(payment.id);
    expect(webhookDetail.json().data.errorCode).toBeNull();
    expect(webhookDetail.body).not.toContain("webhook-secret-must-not-render");
    expect(webhookDetail.body).not.toMatch(/"payload"|"lastError"|password=/u);

    const first = await getOk("/api/admin/users?limit=1");
    expect(first.json().data).toHaveLength(1);
    const cursor = first.json().page.nextCursor;
    expect(typeof cursor).toBe("string");
    const second = await getOk("/api/admin/users?limit=1&cursor=" + encodeURIComponent(cursor));
    expect(second.json().data[0].id).not.toBe(first.json().data[0].id);

    const csv = await get("/api/admin/users/export?q=" + encodeURIComponent(normalEmail));
    expect(csv.statusCode).toBe(200);
    expect(String(csv.headers["content-type"])).toContain("text/csv");
    expect(csv.body).toContain("'=SUM(1)");
    expect(csv.body).not.toContain(prompt);
    const secondCsv = await get("/api/admin/mandates/export");
    expect(secondCsv.statusCode).toBe(200);
    const limited = await get("/api/admin/payments/export");
    expect(limited.statusCode).toBe(429);

    expect((await get(`/api/admin/users/${randomUUID()}`)).statusCode).toBe(404);
    const captured = await getOk("/api/admin/overview");
    expect(captured.json().data.metrics.capturedPayments.value).toBeGreaterThan(0);
    expect(captured.json().data.metrics.disabledUsers.availability).toBe("available");
  });

  it("applies safe user and domain controls without bypassing policy or leaving unaudited mutations", async () => {
    await login();
    await database.adminSessionSecurity.update({
      where: { sessionId },
      data: { reauthenticatedAt: new Date(Date.now() - ADMIN_FRESH_MS) },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/users/${normalId}/disable`,
          payload: JSON.stringify({
            reason: "Investigating fixture account access.",
            confirmation: true,
            requestKey: randomUUID(),
            expectedUpdatedAt: new Date().toISOString(),
            expectedAccessVersion: 0,
            typedConfirmation: normalId,
          }),
          headers: { origin, "content-type": "application/json", cookie },
        })
      ).json().error.code,
    ).toBe("ADMIN_REAUTH_REQUIRED");
    await login();
    await database.user.update({
      where: { id: normalId },
      data: { globalAutonomousPurchasingEnabled: true },
    });
    const user = (
      await app.inject({
        method: "GET",
        url: `/api/admin/users/${normalId}`,
        headers: { cookie },
      })
    ).json().data as {
      updatedAt: string;
      accessVersion: number;
      autonomousPurchasingEnabled: boolean;
    };
    expect(user.autonomousPurchasingEnabled).toBe(true);
    const reason = "Investigating fixture account access.";
    const mutate = (url: string, payload: unknown) =>
      app.inject({
        method: "POST",
        url,
        payload: JSON.stringify(payload),
        headers: { origin, "content-type": "application/json", cookie },
      });

    expect(
      (
        await mutate(`/api/admin/users/${adminId}/disable`, {
          reason,
          confirmation: true,
          requestKey: randomUUID(),
          expectedUpdatedAt: user.updatedAt,
          expectedAccessVersion: 0,
          typedConfirmation: adminId,
        })
      ).statusCode,
    ).toBe(403);

    expect(
      (
        await mutate(`/api/admin/users/${normalId}/disable`, {
          confirmation: true,
          requestKey: randomUUID(),
          expectedUpdatedAt: user.updatedAt,
          expectedAccessVersion: user.accessVersion,
          typedConfirmation: normalId,
        })
      ).statusCode,
    ).toBe(400);

    const autonomyKey = randomUUID();
    const autonomy = await mutate(`/api/admin/users/${normalId}/disable-autonomy`, {
      reason,
      confirmation: true,
      requestKey: autonomyKey,
      expectedUpdatedAt: user.updatedAt,
      expectedAccessVersion: user.accessVersion,
    });
    expect(autonomy.statusCode, autonomy.body).toBe(200);
    expect(autonomy.json().changed).toBe(true);
    const retryAutonomy = await mutate(`/api/admin/users/${normalId}/disable-autonomy`, {
      reason,
      confirmation: true,
      requestKey: autonomyKey,
      expectedUpdatedAt: user.updatedAt,
      expectedAccessVersion: user.accessVersion,
    });
    expect(retryAutonomy.statusCode).toBe(200);
    expect(retryAutonomy.json().changed).toBe(false);
    expect(retryAutonomy.json().actionId).toBe(autonomy.json().actionId);

    const afterAutonomy = (
      await app.inject({
        method: "GET",
        url: `/api/admin/users/${normalId}`,
        headers: { cookie },
      })
    ).json().data as { updatedAt: string; accessVersion: number };
    expect(
      (
        await mutate(`/api/admin/users/${normalId}/disable`, {
          reason,
          confirmation: true,
          requestKey: randomUUID(),
          expectedUpdatedAt: user.updatedAt,
          expectedAccessVersion: user.accessVersion,
          typedConfirmation: normalId,
        })
      ).statusCode,
    ).toBe(409);

    const note = await mutate(`/api/admin/users/${normalId}/notes`, {
      reason,
      requestKey: randomUUID(),
      body: "Follow up with the account owner after the investigation.",
    });
    expect(note.statusCode, note.body).toBe(200);
    expect(note.json().data.body).toContain("Follow up");
    const notes = await app.inject({
      method: "GET",
      url: `/api/admin/users/${normalId}/notes?limit=10`,
      headers: { cookie },
    });
    expect(notes.statusCode).toBe(200);
    expect(notes.json().data.some((row: { body: string }) => row.body.includes("Follow up"))).toBe(
      true,
    );

    const disable = await mutate(`/api/admin/users/${normalId}/disable`, {
      reason,
      confirmation: true,
      requestKey: randomUUID(),
      expectedUpdatedAt: afterAutonomy.updatedAt,
      expectedAccessVersion: afterAutonomy.accessVersion,
      typedConfirmation: normalId,
    });
    expect(disable.statusCode, disable.body).toBe(200);
    expect(disable.json().data.accessStatus).toBe("disabled");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/me",
          headers: { cookie: normalCookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/sign-in/email",
          payload: { email: normalEmail, password },
          headers: { origin: config.APP_URL, "content-type": "application/json" },
        })
      ).json().code,
    ).toBe("ACCOUNT_DISABLED");

    const disabledUser = disable.json().data as { updatedAt: string; accessVersion: number };
    const enable = await mutate(`/api/admin/users/${normalId}/enable`, {
      reason,
      confirmation: true,
      requestKey: randomUUID(),
      expectedUpdatedAt: disabledUser.updatedAt,
      expectedAccessVersion: disabledUser.accessVersion,
    });
    expect(enable.statusCode, enable.body).toBe(200);
    expect(enable.json().data.accessStatus).toBe("enabled");

    const enabledUser = enable.json().data as { updatedAt: string; accessVersion: number };
    const sessions = await mutate(`/api/admin/users/${normalId}/revoke-sessions`, {
      reason,
      confirmation: true,
      requestKey: randomUUID(),
      expectedUpdatedAt: enabledUser.updatedAt,
      expectedAccessVersion: enabledUser.accessVersion,
    });
    expect(sessions.statusCode, sessions.body).toBe(200);

    const sample = await database.purchaseProposal.findFirstOrThrow({
      where: { userId: normalId, isSample: true },
    });
    expect(
      (
        await mutate(`/api/admin/proposals/${sample.id}/re-evaluate`, {
          reason,
          confirmation: true,
          requestKey: randomUUID(),
          expectedStatus: sample.status,
          expectedUpdatedAt: sample.updatedAt.toISOString(),
        })
      ).statusCode,
    ).toBe(409);

    const mandate = await database.mandate.findFirstOrThrow({
      where: { userId: normalId, status: "ACTIVE" },
    });
    const proposed = await new ProposalRepository(database).create({
      userId: normalId,
      mandateId: mandate.id,
      mandateVersionId: mandate.activeVersionId ?? "",
      productSnapshotId: (
        await database.productSnapshot.findFirstOrThrow({
          where: { source: "admin-ops-test" },
        })
      ).id,
      quantity: 1,
      shipping: 0n,
      tax: 0n,
      idempotencyKey: `admin-controls-proposal-${randomUUID()}`,
    });
    expect(
      (
        await mutate(`/api/admin/proposals/${proposed.id}/re-evaluate`, {
          reason,
          confirmation: true,
          requestKey: randomUUID(),
          expectedStatus: "COMPLETED",
          expectedUpdatedAt: proposed.updatedAt.toISOString(),
        })
      ).statusCode,
    ).toBe(409);
    const evaluated = await mutate(`/api/admin/proposals/${proposed.id}/re-evaluate`, {
      reason,
      confirmation: true,
      requestKey: randomUUID(),
      expectedStatus: proposed.status,
      expectedUpdatedAt: proposed.updatedAt.toISOString(),
    });
    expect(evaluated.statusCode, evaluated.body).toBe(200);
    expect(["AUTHORIZED", "AWAITING_APPROVAL", "BLOCKED"]).toContain(evaluated.json().data.status);

    const pause = await mutate(`/api/admin/mandates/${mandate.id}/pause`, {
      reason,
      confirmation: true,
      requestKey: randomUUID(),
      expectedVersion: mandate.version,
      expectedStatus: "ACTIVE",
      typedConfirmation: mandate.id,
    });
    expect(pause.statusCode, pause.body).toBe(200);
    expect(pause.json().data.status).toBe("PAUSED");
    const paused = pause.json().data as { version: number; status: string };
    expect(
      (
        await mutate(`/api/admin/mandates/${mandate.id}/pause`, {
          reason,
          confirmation: true,
          requestKey: randomUUID(),
          expectedVersion: mandate.version,
          expectedStatus: "ACTIVE",
          typedConfirmation: mandate.id,
        })
      ).statusCode,
    ).toBe(409);
    const revoked = await mutate(`/api/admin/mandates/${mandate.id}/revoke`, {
      reason,
      confirmation: true,
      requestKey: randomUUID(),
      expectedVersion: paused.version,
      expectedStatus: "PAUSED",
      typedConfirmation: mandate.id,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().data.status).toBe("REVOKED");

    const events = await app.inject({
      method: "GET",
      url: `/api/admin/audit?targetType=USER&targetId=${normalId}&limit=50`,
      headers: { cookie },
    });
    expect(events.statusCode).toBe(200);
    const actions = events.json().data.map((row: { action: string }) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "ADMIN_AUTONOMY_DISABLED",
        "ADMIN_NOTE_ADDED",
        "ADMIN_USER_DISABLED",
        "ADMIN_USER_ENABLED",
        "ADMIN_SESSIONS_REVOKED",
      ]),
    );
    expect(events.body).not.toMatch(/password|"token"/u);
    const mandateEvents = await app.inject({
      method: "GET",
      url: `/api/admin/audit?targetType=MANDATE&targetId=${mandate.id}&limit=20`,
      headers: { cookie },
    });
    expect(mandateEvents.statusCode).toBe(200);
    expect(mandateEvents.json().data.map((row: { action: string }) => row.action)).toEqual(
      expect.arrayContaining(["ADMIN_MANDATE_PAUSED", "ADMIN_MANDATE_REVOKED"]),
    );
    const proposalEvents = await app.inject({
      method: "GET",
      url: `/api/admin/audit?targetType=PROPOSAL&targetId=${proposed.id}&limit=20`,
      headers: { cookie },
    });
    expect(proposalEvents.statusCode).toBe(200);
    expect(proposalEvents.json().data.map((row: { action: string }) => row.action)).toContain(
      "ADMIN_PROPOSAL_RE_EVALUATED",
    );
  });

  it("reconciles payments, refreshes refunds and retries webhooks without duplicating captures", async () => {
    await login();
    const reason = "Recovering a sandbox payment after a lost provider response.";
    const mutate = (url: string, payload: unknown) =>
      app.inject({
        method: "POST",
        url,
        payload: JSON.stringify(payload),
        headers: { origin, "content-type": "application/json", cookie },
      });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/payments/${randomUUID()}/reconcile`,
          payload: JSON.stringify({
            reason,
            confirmation: true,
            requestKey: randomUUID(),
            expectedStatus: "CREATED",
            expectedUpdatedAt: new Date().toISOString(),
          }),
          headers: { origin, "content-type": "application/json" },
        })
      ).statusCode,
    ).toBe(401);
    const normalSession = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: normalEmail, password },
      headers: { origin: config.APP_URL, "content-type": "application/json" },
    });
    expect(normalSession.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/payments/${randomUUID()}/reconcile`,
          payload: JSON.stringify({
            reason,
            confirmation: true,
            requestKey: randomUUID(),
            expectedStatus: "CREATED",
            expectedUpdatedAt: new Date().toISOString(),
          }),
          headers: {
            origin,
            "content-type": "application/json",
            cookie: cookies(normalSession),
          },
        })
      ).statusCode,
    ).toBe(403);

    const mandate = await new MandateRepository(database).create({
      userId: normalId,
      title: "Admin finance headphones",
      originalPrompt: "Buy demo headphones for finance recovery tests.",
      status: "ACTIVE",
      autoSpendLimit: 20_000n,
      transactionLimit: 20_000n,
      dailyLimit: 50_000n,
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 86_400_000),
      rules: [{ ruleType: "ALLOWED_BRAND", operator: "IN", value: ["Sony"] }],
    });
    const product = await database.productSnapshot.findFirstOrThrow({
      where: { source: "admin-ops-test" },
    });
    const proposal = await new ProposalRepository(database).create({
      userId: normalId,
      mandateId: mandate.id,
      mandateVersionId: mandate.activeVersionId ?? "",
      productSnapshotId: product.id,
      quantity: 1,
      shipping: 0n,
      tax: 0n,
      idempotencyKey: `admin-finance-proposal-${randomUUID()}`,
    });
    const paypalOrderId = `ORDER-ADMIN-FINANCE-${randomUUID()}`;
    const pendingPayment = await database.payment.create({
      data: {
        userId: normalId,
        mandateId: mandate.id,
        proposalId: proposal.id,
        paypalOrderId,
        amount: 10_000n,
        currency: "USD",
        status: "CREATED",
        idempotencyKey: `admin-finance-pending-${randomUUID()}`,
      },
    });
    getOrder.mockResolvedValue({
      id: paypalOrderId,
      status: "APPROVED",
      links: [],
      purchase_units: [
        {
          reference_id: pendingPayment.id,
          custom_id: proposal.id,
          amount: { currency_code: "USD", value: "100.00" },
        },
      ],
      approvalUrl: "https://sandbox.paypal.com/checkoutnow?token=" + paypalOrderId,
    });
    const currentPending = (
      await app.inject({
        method: "GET",
        url: `/api/admin/payments/${pendingPayment.id}`,
        headers: { cookie },
      })
    ).json().data as { updatedAt: string; paymentStatus: string };
    const missingReason = await mutate(`/api/admin/payments/${pendingPayment.id}/reconcile`, {
      confirmation: true,
      requestKey: randomUUID(),
      expectedStatus: currentPending.paymentStatus,
      expectedUpdatedAt: currentPending.updatedAt,
    });
    expect(missingReason.statusCode, missingReason.body).toBe(400);
    const reconcileKey = randomUUID();
    const reconciled = await mutate(`/api/admin/payments/${pendingPayment.id}/reconcile`, {
      reason,
      confirmation: true,
      requestKey: reconcileKey,
      expectedStatus: currentPending.paymentStatus,
      expectedUpdatedAt: currentPending.updatedAt,
    });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(reconciled.json().data.paymentStatus).toBe("APPROVED");
    expect(getOrder).toHaveBeenCalledWith(paypalOrderId);
    const retryReconcile = await mutate(`/api/admin/payments/${pendingPayment.id}/reconcile`, {
      reason,
      confirmation: true,
      requestKey: reconcileKey,
      expectedStatus: currentPending.paymentStatus,
      expectedUpdatedAt: currentPending.updatedAt,
    });
    expect(retryReconcile.statusCode).toBe(200);
    expect(retryReconcile.json().changed).toBe(false);
    expect(retryReconcile.json().actionId).toBe(reconciled.json().actionId);
    const currentApproved = (
      await app.inject({
        method: "GET",
        url: `/api/admin/orders/${pendingPayment.id}`,
        headers: { cookie },
      })
    ).json().data as { updatedAt: string; paymentStatus: string };
    const orderReconcile = await mutate(`/api/admin/orders/${pendingPayment.id}/reconcile`, {
      reason,
      confirmation: true,
      requestKey: randomUUID(),
      expectedStatus: currentApproved.paymentStatus,
      expectedUpdatedAt: currentApproved.updatedAt,
    });
    expect(orderReconcile.statusCode, orderReconcile.body).toBe(200);
    expect(orderReconcile.json().data.paymentStatus).toBe("APPROVED");

    const capturedProposal = await new ProposalRepository(database).create({
      userId: normalId,
      mandateId: mandate.id,
      mandateVersionId: mandate.activeVersionId ?? "",
      productSnapshotId: product.id,
      quantity: 1,
      shipping: 0n,
      tax: 0n,
      idempotencyKey: `admin-finance-captured-${randomUUID()}`,
    });
    const captureId = `CAPTURE-ADMIN-FINANCE-${randomUUID()}`;
    const capturedPayment = await database.payment.create({
      data: {
        userId: normalId,
        mandateId: mandate.id,
        proposalId: capturedProposal.id,
        paypalOrderId: `ORDER-ADMIN-FINANCE-CAP-${randomUUID()}`,
        paypalCaptureId: captureId,
        amount: 10_000n,
        currency: "USD",
        status: "COMPLETED",
        capturedAt: new Date(),
        idempotencyKey: `admin-finance-captured-pay-${randomUUID()}`,
      },
    });
    await database.purchaseProposal.update({
      where: { id: capturedProposal.id },
      data: { status: "COMPLETED" },
    });
    getCapture.mockResolvedValue({
      id: captureId,
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "100.00" },
      custom_id: capturedProposal.id,
      create_time: "2026-10-06T12:00:00Z",
      supplementary_data: { related_ids: { order_id: capturedPayment.paypalOrderId } },
    });
    refundCapture.mockImplementation(async (input) => {
      const body = input as { invoiceId: string; amountMinor: number; captureId: string };
      return {
        id: `REFUND-${body.invoiceId}`,
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "100.00" },
        invoice_id: body.invoiceId,
        capture_id: body.captureId,
        create_time: "2026-10-06T12:05:00Z",
      };
    });
    const captured = (
      await app.inject({
        method: "GET",
        url: `/api/admin/payments/${capturedPayment.id}`,
        headers: { cookie },
      })
    ).json().data as {
      updatedAt: string;
      paymentStatus: string;
      remainingRefundableMinor: number;
    };
    expect(captured.remainingRefundableMinor).toBe(10_000);
    await database.adminSessionSecurity.update({
      where: { sessionId },
      data: { reauthenticatedAt: new Date(Date.now() - ADMIN_FRESH_MS) },
    });
    expect(
      (
        await mutate(`/api/admin/payments/${capturedPayment.id}/refund`, {
          reason,
          confirmation: true,
          requestKey: randomUUID(),
          expectedStatus: captured.paymentStatus,
          expectedUpdatedAt: captured.updatedAt,
          amountMinor: null,
          reviewedAmountMinor: 10_000,
          typedConfirmation: capturedPayment.id,
        })
      ).json().error.code,
    ).toBe("ADMIN_REAUTH_REQUIRED");
    await login();
    expect(
      (
        await mutate(`/api/admin/payments/${capturedPayment.id}/refund`, {
          reason,
          confirmation: true,
          requestKey: randomUUID(),
          expectedStatus: captured.paymentStatus,
          expectedUpdatedAt: captured.updatedAt,
          amountMinor: null,
          reviewedAmountMinor: 1,
          typedConfirmation: capturedPayment.id,
        })
      ).statusCode,
    ).toBe(400);
    const refundKey = randomUUID();
    const refunded = await mutate(`/api/admin/payments/${capturedPayment.id}/refund`, {
      reason,
      confirmation: true,
      requestKey: refundKey,
      expectedStatus: captured.paymentStatus,
      expectedUpdatedAt: captured.updatedAt,
      amountMinor: null,
      reviewedAmountMinor: 10_000,
      typedConfirmation: capturedPayment.id,
    });
    expect(refunded.statusCode, refunded.body).toBe(200);
    expect(refunded.json().data.paymentStatus).toBe("REFUNDED");
    expect(refundCapture).toHaveBeenCalledOnce();
    const retryRefund = await mutate(`/api/admin/payments/${capturedPayment.id}/refund`, {
      reason,
      confirmation: true,
      requestKey: refundKey,
      expectedStatus: captured.paymentStatus,
      expectedUpdatedAt: captured.updatedAt,
      amountMinor: null,
      reviewedAmountMinor: 10_000,
      typedConfirmation: capturedPayment.id,
    });
    expect(retryRefund.statusCode).toBe(200);
    expect(retryRefund.json().changed).toBe(false);
    expect(refundCapture).toHaveBeenCalledOnce();

    const createdRefund = await database.refund.findFirstOrThrow({
      where: { paymentId: capturedPayment.id, idempotencyKey: refundKey },
    });
    expect(createdRefund.paypalRequestId).toBeTruthy();
    const refreshed = await mutate(`/api/admin/refunds/${createdRefund.id}/refresh`, {
      reason,
      confirmation: true,
      requestKey: randomUUID(),
      expectedStatus: createdRefund.status,
      expectedUpdatedAt: createdRefund.updatedAt.toISOString(),
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);

    const webhook = await database.webhookInbox.create({
      data: {
        provider: "paypal",
        providerEventId: `admin-finance-${randomUUID()}`,
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        signatureVerified: true,
        payload: {
          id: `EVT-${randomUUID()}`,
          event_type: "PAYMENT.CAPTURE.COMPLETED",
          resource: {
            id: captureId,
            supplementary_data: {
              related_ids: { order_id: capturedPayment.paypalOrderId },
            },
          },
        },
        status: "FAILED",
        attempts: 1,
        nextAttemptAt: new Date(Date.now() - 1_000),
      },
    });
    getOrder.mockResolvedValue({
      id: capturedPayment.paypalOrderId!,
      status: "COMPLETED",
      links: [],
      purchase_units: [
        {
          reference_id: capturedPayment.id,
          custom_id: capturedProposal.id,
          amount: { currency_code: "USD", value: "100.00" },
          payments: {
            captures: [
              {
                id: captureId,
                status: "COMPLETED",
                amount: { currency_code: "USD", value: "100.00" },
                custom_id: capturedProposal.id,
                create_time: "2026-10-06T12:00:00Z",
              },
            ],
          },
        },
      ],
      approvalUrl: "https://sandbox.paypal.com/checkoutnow?token=" + capturedPayment.paypalOrderId,
    });
    const webhookRow = (
      await app.inject({
        method: "GET",
        url: `/api/admin/webhooks/${webhook.id}`,
        headers: { cookie },
      })
    ).json().data as {
      updatedAt: string;
      status: string;
      attempts: number;
      retryEligible: boolean;
    };
    expect(webhookRow.retryEligible).toBe(true);
    const duplicate = await Promise.all([
      mutate(`/api/admin/webhooks/${webhook.id}/retry`, {
        reason,
        confirmation: true,
        requestKey: randomUUID(),
        expectedStatus: webhookRow.status,
        expectedUpdatedAt: webhookRow.updatedAt,
        expectedAttempts: webhookRow.attempts,
      }),
      mutate(`/api/admin/webhooks/${webhook.id}/retry`, {
        reason,
        confirmation: true,
        requestKey: randomUUID(),
        expectedStatus: webhookRow.status,
        expectedUpdatedAt: webhookRow.updatedAt,
        expectedAttempts: webhookRow.attempts,
      }),
    ]);
    expect(
      duplicate.some((row) => row.statusCode === 200),
      duplicate.map((row) => row.body).join("\n"),
    ).toBe(true);
    expect(duplicate.some((row) => row.statusCode === 409)).toBe(true);
    const afterRetry = await database.webhookInbox.findUniqueOrThrow({ where: { id: webhook.id } });
    expect(afterRetry.attempts).toBeGreaterThan(webhook.attempts);

    const linked = await mutate(`/api/admin/webhooks/${webhook.id}/reconcile`, {
      reason,
      confirmation: true,
      requestKey: randomUUID(),
      expectedStatus: (await database.webhookInbox.findUniqueOrThrow({ where: { id: webhook.id } }))
        .status,
      expectedUpdatedAt: (
        await database.webhookInbox.findUniqueOrThrow({ where: { id: webhook.id } })
      ).updatedAt.toISOString(),
    });
    expect(linked.statusCode, linked.body).toBe(200);

    const events = await app.inject({
      method: "GET",
      url: `/api/admin/audit?targetType=PAYMENT&targetId=${pendingPayment.id}&limit=20`,
      headers: { cookie },
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().data.map((row: { action: string }) => row.action)).toContain(
      "ADMIN_PAYMENT_RECONCILE_REQUESTED",
    );
    const refundEvents = await app.inject({
      method: "GET",
      url: `/api/admin/audit?targetType=REFUND&targetId=${capturedPayment.id}&limit=20`,
      headers: { cookie },
    });
    expect(refundEvents.json().data.map((row: { action: string }) => row.action)).toContain(
      "ADMIN_REFUND_REQUESTED",
    );
    const webhookEvents = await app.inject({
      method: "GET",
      url: `/api/admin/audit?targetType=WEBHOOK&targetId=${webhook.id}&limit=20`,
      headers: { cookie },
    });
    expect(webhookEvents.json().data.map((row: { action: string }) => row.action)).toEqual(
      expect.arrayContaining([
        "ADMIN_WEBHOOK_RETRY_REQUESTED",
        "ADMIN_WEBHOOK_RECONCILE_REQUESTED",
      ]),
    );
    expect(events.body).not.toMatch(/password|"token"/u);
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
