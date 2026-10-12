import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AuthRuntime } from "./auth.js";
import { env } from "./env.js";
import { generateMandateSigningJwk } from "./services/mandate-credentials.js";

const proxySecret = "fixture-internal-proxy-secret-0123456789";
const testConfig = {
  ...env,
  NODE_ENV: "test" as const,
  LOG_LEVEL: "silent" as const,
  INTERNAL_PROXY_SECRET: proxySecret,
  TRUST_PROXY: undefined,
};

/** Records what reached Better Auth without touching a database. */
function fakeAuthRuntime() {
  const seen: Array<{ clientIp: string | null; proxySecret: string | null }> = [];
  const runtime = {
    auth: {
      handler: async (request: Request) => {
        seen.push({
          clientIp: request.headers.get("x-mandatepay-client-ip"),
          proxySecret: request.headers.get("x-mandatepay-proxy-secret"),
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      api: { getSession: async () => null },
    },
    database: {},
    requireEmailVerification: false,
    flushEmails: async () => undefined,
    close: async () => undefined,
  };
  return { runtime: runtime as unknown as AuthRuntime, seen };
}

function signIn(email: string, headers: Record<string, string> = {}) {
  return {
    method: "POST" as const,
    url: "/api/auth/sign-in/email",
    headers: { "content-type": "application/json", ...headers },
    payload: { email, password: "fixture-password-value" },
  };
}

function forwarded(ip: string, secret = proxySecret) {
  return { "x-mandatepay-client-ip": ip, "x-mandatepay-proxy-secret": secret };
}

describe("foundation API", () => {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("reports a healthy foundation service", async () => {
    app = await createApp({ authRuntime: null });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "mandatepay-api",
      stage: "mvp",
      productDiscoveryMode: "demo",
    });
  });

  it("does not register domain routes without an authenticated runtime", async () => {
    app = await createApp({ authRuntime: null });

    const response = await app.inject({ method: "GET", url: "/api/mandates" });

    expect(response.statusCode).toBe(404);
  });

  it("fails closed when authentication configuration is unavailable", async () => {
    app = await createApp({ authRuntime: null });

    const auth = await app.inject({ method: "GET", url: "/api/auth/ok" });
    expect(auth.statusCode).toBe(503);
    expect(auth.json()).toEqual({
      error: "Authentication is temporarily unavailable.",
      code: "AUTH_UNAVAILABLE",
    });

    const readiness = await app.inject({ method: "GET", url: "/health/ready" });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({
      status: "unavailable",
      code: "AUTH_UNAVAILABLE",
    });
  });

  it("does not permit fixture authentication limits outside test mode", async () => {
    await expect(
      createApp({
        authRuntime: null,
        config: { ...env, NODE_ENV: "production" },
        testAuthPostMaximum: 200,
      }),
    ).rejects.toThrow("only by isolated test servers");
  });

  it("ignores a spoofed client address without the internal proxy secret", async () => {
    const { runtime, seen } = fakeAuthRuntime();
    app = await createApp({ authRuntime: runtime, paypalClient: null, config: testConfig });

    for (const headers of [
      { "x-mandatepay-client-ip": "203.0.113.9" },
      forwarded("203.0.113.9", "wrong-secret-of-a-similar-length-000000"),
    ]) {
      const response = await app.inject(signIn("spoof@example.test", headers));
      expect(response.statusCode).toBe(200);
    }

    expect(seen).toEqual([
      { clientIp: "127.0.0.1", proxySecret: null },
      { clientIp: "127.0.0.1", proxySecret: null },
    ]);
  });

  it("trusts the BFF-forwarded client address only with the shared secret", async () => {
    const { runtime, seen } = fakeAuthRuntime();
    app = await createApp({ authRuntime: runtime, paypalClient: null, config: testConfig });

    await app.inject(signIn("a@example.test", forwarded("203.0.113.9")));
    await app.inject(signIn("b@example.test", forwarded("not-an-ip")));
    await app.inject(signIn("c@example.test", { "x-mandatepay-proxy-secret": proxySecret }));

    // The secret never reaches Better Auth; invalid or missing addresses fall back to the socket.
    expect(seen).toEqual([
      { clientIp: "203.0.113.9", proxySecret: null },
      { clientIp: "127.0.0.1", proxySecret: null },
      { clientIp: "127.0.0.1", proxySecret: null },
    ]);
  });

  it("ignores forwarded client addresses when no proxy secret is configured", async () => {
    const { runtime, seen } = fakeAuthRuntime();
    app = await createApp({
      authRuntime: runtime,
      paypalClient: null,
      config: { ...testConfig, INTERNAL_PROXY_SECRET: undefined },
    });

    await app.inject(signIn("a@example.test", forwarded("203.0.113.9")));

    expect(seen).toEqual([{ clientIp: "127.0.0.1", proxySecret: null }]);
  });

  it("keeps per-address authentication buckets separate behind the BFF", async () => {
    const { runtime } = fakeAuthRuntime();
    app = await createApp({ authRuntime: runtime, paypalClient: null, config: testConfig });

    for (let index = 0; index < 30; index += 1) {
      const response = await app.inject(
        signIn(`user-${index}@example.test`, forwarded("198.51.100.1")),
      );
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject(signIn("late@example.test", forwarded("198.51.100.1")));
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "AUTH_RATE_LIMITED" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

    const otherClient = await app.inject(signIn("late@example.test", forwarded("198.51.100.2")));
    expect(otherClient.statusCode).toBe(200);
  });

  it("limits credential attempts per normalized email across addresses", async () => {
    const { runtime } = fakeAuthRuntime();
    app = await createApp({ authRuntime: runtime, paypalClient: null, config: testConfig });

    for (let index = 0; index < 10; index += 1) {
      const email = index % 2 ? "Target@Example.test" : "  target@example.test ";
      const response = await app.inject(signIn(email, forwarded(`192.0.2.${index + 1}`)));
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject(signIn("TARGET@example.test", forwarded("192.0.2.200")));
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "AUTH_RATE_LIMITED" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

    const otherAccount = await app.inject(signIn("other@example.test", forwarded("192.0.2.200")));
    expect(otherAccount.statusCode).toBe(200);
  });

  it("derives request.ip from X-Forwarded-For only when TRUST_PROXY hops are configured", async () => {
    for (const [TRUST_PROXY, expected] of [
      [undefined, "127.0.0.1"],
      [1, "198.51.100.7"],
    ] as const) {
      app = await createApp({ authRuntime: null, config: { ...testConfig, TRUST_PROXY } });
      app.register(async (scope) => {
        scope.get("/__ip", async (request) => ({ ip: request.ip }));
      });
      const response = await app.inject({
        method: "GET",
        url: "/__ip",
        headers: { "x-forwarded-for": "203.0.113.50, 198.51.100.7" },
      });
      expect(response.json()).toEqual({ ip: expected });
      await app.close();
      app = undefined;
    }
  });

  it("returns a generic body for unexpected errors without leaking internals", async () => {
    app = await createApp({ authRuntime: null, config: testConfig });
    app.get("/__boom", async () => {
      throw new Error(
        "Invalid prisma.user.findUnique() invocation: connection to postgresql://mandatepay:secret@db failed",
      );
    });
    app.get("/__conflict", async () => {
      throw Object.assign(new Error("Unique constraint failed on the fields: (email)"), {
        statusCode: 409,
      });
    });

    const failure = await app.inject({ method: "GET", url: "/__boom" });
    expect(failure.statusCode).toBe(500);
    expect(failure.json()).toEqual({ error: "INTERNAL_ERROR", requestId: expect.any(String) });
    expect(failure.body).not.toMatch(/prisma|postgresql|secret/i);

    const conflict = await app.inject({ method: "GET", url: "/__conflict" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: "Conflict",
      code: "REQUEST_REJECTED",
      requestId: expect.any(String),
    });
    expect(conflict.body).not.toMatch(/constraint|email/i);
  });

  it("keeps Fastify's safe messages for malformed, oversized and unsupported bodies", async () => {
    app = await createApp({ authRuntime: null, config: testConfig });

    const malformed = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: '{"email": "private-value',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "FST_ERR_CTP_INVALID_JSON_BODY" });
    expect(malformed.body).not.toContain("private-value");

    const oversized = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ code: "FST_ERR_CTP_BODY_TOO_LARGE" });

    const unsupported = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/xml" },
      payload: "<credentials />",
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toMatchObject({ code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" });
  });

  it("returns a JSON not-found response with a request id", async () => {
    app = await createApp({ authRuntime: null, config: testConfig });

    const response = await app.inject({ method: "GET", url: "/no-such-route" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "Not found",
      code: "NOT_FOUND",
      requestId: expect.any(String),
    });
  });

  it("publishes the mandate credential JWKS and refuses production without a signing key", async () => {
    app = await createApp({ authRuntime: null, config: testConfig });
    const jwks = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    expect(jwks.statusCode).toBe(200);
    expect(jwks.headers["cache-control"]).toContain("public");
    const keys = (jwks.json() as { keys: Array<Record<string, unknown>> }).keys;
    expect(keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(keys[0]).not.toHaveProperty("d");
    await app.close();
    app = undefined;
    await expect(
      createApp({
        authRuntime: null,
        config: { ...testConfig, NODE_ENV: "production", MANDATE_SIGNING_KEY: undefined },
      }),
    ).rejects.toThrow("MANDATE_SIGNING_KEY");
  });

  it("sends API security headers, with HSTS only in production", async () => {
    app = await createApp({ authRuntime: null, config: testConfig });
    const local = await app.inject({ method: "GET", url: "/health" });
    expect(local.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "cross-origin-resource-policy": "same-site",
    });
    expect(local.headers["strict-transport-security"]).toBeUndefined();
    const missing = await app.inject({ method: "GET", url: "/missing" });
    expect(missing.headers["x-content-type-options"]).toBe("nosniff");
    await app.close();

    app = await createApp({
      authRuntime: null,
      // Production refuses to boot without a mandate credential signing key.
      config: {
        ...testConfig,
        NODE_ENV: "production",
        MANDATE_SIGNING_KEY: JSON.stringify(await generateMandateSigningJwk()),
      },
    });
    const production = await app.inject({ method: "GET", url: "/health" });
    expect(production.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});
