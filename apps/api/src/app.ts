import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import type { DatabaseClient } from "@mandatepay/database";
import { z } from "zod";
import { createAuthRuntime, type AuthRuntime } from "./auth.js";
import { env } from "./env.js";
import { originsFor, trustedOrigin } from "./origins.js";
import { registerAdminRoutes } from "./modules/admin/admin.routes.js";
import {
  loadOpenAIConfig,
  parseMandate,
  rankProducts,
  parseAnalyticsQuery,
  runShoppingAgent,
} from "@mandatepay/agent";
import {
  Channel3Client,
  Channel3ConfigurationError,
  Channel3ProviderError,
  isChannel3Error,
  parseChannel3Config,
  lookupDemoProduct,
} from "@mandatepay/channel3";
import { ObservabilityRepository } from "@mandatepay/database";
import type { PayPalClient } from "@mandatepay/paypal";
import { registerMandateRoutes } from "./routes/mandates.js";
import { registerSimulatorRoutes } from "./routes/simulator.js";
import {
  channel3FallbackMode,
  createChannel3CatalogClient,
  registerCatalogRoutes,
} from "./routes/catalog.js";
import { registerProposalRoutes } from "./routes/proposals.js";
import { registerPayPalRoutes } from "./routes/paypal.js";
import { registerRefundRoutes } from "./routes/refunds.js";
import { registerPaymentMethodRoutes } from "./routes/payment-methods.js";
import { registerCredentialRoutes, registerPublicCredentialRoutes } from "./routes/credentials.js";
import { configureMandateSigning } from "./services/mandate-credentials.js";
import { createVaultCipher } from "./services/vault-crypto.js";
import { createPayPalClientFromEnvironment } from "./services/payments.js";
import { PlatformControlDenied, assertRegistrationOpen } from "./services/platform-controls.js";
import { createPayPalWebhookService } from "./services/webhooks.js";
import { registerPayPalWebhookRoutes } from "./routes/webhooks.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerShoppingAgentRoutes } from "./routes/agent.js";
import { registerAgentTokenRoutes } from "./routes/agent-tokens.js";
import { registerAgentGatewayRoutes } from "./routes/agent-gateway.js";
import {
  GATEWAY_PRINCIPAL_HEADER,
  createGatewayPrincipals,
  deriveAgentTokenKey,
  type GatewayPrincipals,
} from "./services/agent-tokens.js";
import {
  createFixedWindowRateLimiter,
  createMutationRateLimiter,
  credentialAttemptEmail,
  isFinancialMutation,
  safeRequestPath,
} from "./services/rate-limits.js";
import {
  apiSecurityHeaders,
  applySecurityHeaders,
  deriveProductContextSecret,
  pinClientIp,
  sendNotFound,
  sendUnhandledError,
  trustProxyHops,
} from "./request-security.js";

const settingsSchema = z
  .object({
    autonomousPurchasingEnabled: z.boolean(),
  })
  .strict();

const authPostWindowMs = 60_000;
const authPostMaxRequests = 30;
const authPostCapacity = 4_096;
// Credential attempts against one account, independent of the caller's address.
const credentialEmailWindowMs = 15 * 60_000;
const credentialEmailMaxRequests = 10;
const credentialEmailCapacity = 10_000;

type RuntimeConfig = typeof env;

export interface CreateAppOptions {
  config?: RuntimeConfig;
  authRuntime?: AuthRuntime | null;
  database?: DatabaseClient;
  /** Programmatic test dependency. HTTP clients cannot configure this. */
  paypalClient?: PayPalClient | null;
  /** Isolated test servers can provision many fixture accounts from loopback. */
  testAuthPostMaximum?: number;
  /** Isolated admin tests can raise the principal read bucket without changing production limits. */
  testAdminReadMaximum?: number;
  /** Isolated admin tests can raise the principal mutation bucket without changing production limits. */
  testAdminMutationMaximum?: number;
  /** Isolated admin tests can raise the financial recovery bucket without changing production limits. */
  testAdminFinancialMaximum?: number;
  /** Replaces the live PayPal Sandbox probe. HTTP clients cannot set this. */
  probePaypal?: () => Promise<{
    status: "ready" | "degraded" | "unavailable";
    code: string;
    latencyMs: number;
  }>;
  /** Replaces the live Channel3 probe. HTTP clients cannot set this. */
  probeChannel3?: () => Promise<{
    status: "ready" | "degraded" | "unavailable";
    code: string;
    latencyMs: number;
  }>;
}

function isTrustedOrigin(origin: string | undefined, config: RuntimeConfig): boolean {
  return trustedOrigin(origin, [
    ...originsFor(config.APP_URL, config.NODE_ENV),
    ...originsFor(config.ADMIN_ORIGIN, config.NODE_ENV),
  ]);
}

function safeLoggerConfig(config: RuntimeConfig) {
  return {
    level: config.LOG_LEVEL,
    serializers: {
      req: (request: { method: string; url: string }) => ({
        method: request.method,
        url: safeRequestPath(request.url),
      }),
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.set-cookie",
        "req.headers.x-api-key",
        "req.headers.x-mandatepay-proxy-secret",
        "req.headers.x-mandatepay-gateway-principal",
        "req.body.password",
        "req.body.clientSecret",
        "req.body.paypalClientSecret",
        "res.headers.set-cookie",
      ],
      censor: "[REDACTED]",
    },
  };
}

function resolveAuthRuntime(options: CreateAppOptions, config: RuntimeConfig): AuthRuntime | null {
  if (options.authRuntime !== undefined) return options.authRuntime;
  if (!config.DATABASE_URL || !config.AUTH_SECRET) return null;

  try {
    return createAuthRuntime({
      database: options.database,
      databaseUrl: config.DATABASE_URL,
      authSecret: config.AUTH_SECRET,
      appUrl: config.APP_URL,
      adminOrigin: config.ADMIN_ORIGIN,
      nodeEnv: config.NODE_ENV,
      testRateLimitMaximum: options.testAuthPostMaximum,
      requireEmailVerification: config.AUTH_REQUIRE_EMAIL_VERIFICATION,
      resendApiKey: config.RESEND_API_KEY,
      authEmailFrom: config.AUTH_EMAIL_FROM,
    });
  } catch {
    return null;
  }
}

function sendUnavailable(reply: FastifyReply) {
  return reply.status(503).send({
    error: "Authentication is temporarily unavailable.",
    code: "AUTH_UNAVAILABLE",
  });
}

async function readAuthenticatedUser(
  request: FastifyRequest,
  runtime: AuthRuntime,
  reply: FastifyReply,
) {
  try {
    const session = await runtime.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    const userId = session?.user?.id;
    if (typeof userId !== "string" || !userId) {
      await reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
      return null;
    }
    return await readActiveUser(userId, runtime, reply);
  } catch {
    await sendUnavailable(reply);
    return null;
  }
}

/**
 * The agent gateway's internal calls (Fastify inject) name the token owner with a
 * single-use in-process nonce instead of a session cookie. Any unknown, reused or
 * expired value is rejected; it never falls back to cookies.
 */
async function readGatewayPrincipalUser(
  request: FastifyRequest,
  runtime: AuthRuntime,
  reply: FastifyReply,
  principals: GatewayPrincipals,
) {
  const userId = principals.consume(request.headers[GATEWAY_PRINCIPAL_HEADER]);
  if (!userId) {
    await reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
    return null;
  }
  return readActiveUser(userId, runtime, reply);
}

async function readActiveUser(userId: string, runtime: AuthRuntime, reply: FastifyReply) {
  try {
    const user = await runtime.database.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        globalAutonomousPurchasingEnabled: true,
        disabledAt: true,
      },
    });
    if (!user) {
      await reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
      return null;
    }
    if (user.disabledAt) {
      await reply.status(403).send({
        error: "This account is disabled.",
        code: "ACCOUNT_DISABLED",
      });
      return null;
    }
    if (runtime.requireEmailVerification && !user.emailVerified) {
      await reply.status(403).send({
        error: "Verify your email before opening the workspace.",
        code: "EMAIL_NOT_VERIFIED",
      });
      return null;
    }
    return user;
  } catch {
    await sendUnavailable(reply);
    return null;
  }
}

async function forwardAuthResponse(response: Response, reply: FastifyReply) {
  const setCookies =
    typeof (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie ===
    "function"
      ? (response.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : [];

  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") reply.header(key, value);
  });
  if (setCookies.length) reply.header("set-cookie", setCookies);

  const body = response.status === 204 || response.status === 205 ? null : await response.text();
  return reply.status(response.status).send(body || null);
}

async function rejectDisabledCredentialSession(
  runtime: AuthRuntime,
  request: FastifyRequest,
  reply: FastifyReply,
  response: Response,
) {
  const path = request.url.split("?")[0] ?? "";
  const credential =
    request.method === "POST" &&
    (path.endsWith("/sign-in/email") || path.endsWith("/sign-up/email"));
  if (!credential || response.status >= 400) return forwardAuthResponse(response, reply);
  const setCookies =
    typeof (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie ===
    "function"
      ? (response.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : [];
  const body = await response.text();
  let userId: string | undefined;
  try {
    const parsed = JSON.parse(body) as { user?: { id?: unknown } };
    userId = typeof parsed.user?.id === "string" ? parsed.user.id : undefined;
  } catch {
    return reconstructAuthResponse(reply, response, setCookies, body);
  }
  if (!userId) return reconstructAuthResponse(reply, response, setCookies, body);
  const user = await runtime.database.user.findUnique({
    where: { id: userId },
    select: { disabledAt: true },
  });
  if (!user?.disabledAt) return reconstructAuthResponse(reply, response, setCookies, body);
  await runtime.database.session.deleteMany({ where: { userId } });
  return reply.status(403).send({
    error: "This account is disabled.",
    code: "ACCOUNT_DISABLED",
  });
}

function reconstructAuthResponse(
  reply: FastifyReply,
  response: Response,
  setCookies: string[],
  body: string,
) {
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") reply.header(key, value);
  });
  if (setCookies.length) reply.header("set-cookie", setCookies);
  return reply.status(response.status).send(body || null);
}

function buildAuthRequest(request: FastifyRequest, config: RuntimeConfig): Request {
  const url = new URL(request.url, config.APP_URL);
  const headers = fromNodeHeaders(request.headers);
  headers.delete("content-length");
  headers.delete("host");
  headers.set("x-mandatepay-client-ip", request.ip);
  const rawBody = request.body;
  const body =
    rawBody === undefined
      ? undefined
      : typeof rawBody === "string"
        ? rawBody
        : JSON.stringify(rawBody);

  return new Request(url, {
    method: request.method,
    headers,
    body,
  });
}

export async function createApp(options: CreateAppOptions = {}) {
  const config = options.config ?? env;
  if (
    (options.testAuthPostMaximum !== undefined ||
      options.testAdminReadMaximum !== undefined ||
      options.testAdminMutationMaximum !== undefined ||
      options.testAdminFinancialMaximum !== undefined) &&
    (config.NODE_ENV !== "test" ||
      (options.testAuthPostMaximum !== undefined &&
        (!Number.isSafeInteger(options.testAuthPostMaximum) ||
          options.testAuthPostMaximum < 1 ||
          options.testAuthPostMaximum > 500)) ||
      (options.testAdminReadMaximum !== undefined &&
        (!Number.isSafeInteger(options.testAdminReadMaximum) ||
          options.testAdminReadMaximum < 1 ||
          options.testAdminReadMaximum > 2000)) ||
      (options.testAdminMutationMaximum !== undefined &&
        (!Number.isSafeInteger(options.testAdminMutationMaximum) ||
          options.testAdminMutationMaximum < 1 ||
          options.testAdminMutationMaximum > 500)) ||
      (options.testAdminFinancialMaximum !== undefined &&
        (!Number.isSafeInteger(options.testAdminFinancialMaximum) ||
          options.testAdminFinancialMaximum < 1 ||
          options.testAdminFinancialMaximum > 500)))
  ) {
    throw new Error("Authentication fixture limits are supported only by isolated test servers.");
  }
  const maximumAuthRequests = options.testAuthPostMaximum ?? authPostMaxRequests;
  const runtime = resolveAuthRuntime(options, config);
  const paypal =
    runtime === null
      ? null
      : options.paypalClient !== undefined
        ? options.paypalClient
        : createPayPalClientFromEnvironment(config);
  const consumeAuthPost = createFixedWindowRateLimiter({
    maximum: maximumAuthRequests,
    windowMs: authPostWindowMs,
    capacity: authPostCapacity,
  });
  const consumeCredentialEmail = createFixedWindowRateLimiter({
    maximum: options.testAuthPostMaximum ?? credentialEmailMaxRequests,
    windowMs: credentialEmailWindowMs,
    capacity: credentialEmailCapacity,
  });
  const app = Fastify({
    logger: safeLoggerConfig(config),
    genReqId: () => randomUUID(),
    // Direct traffic only (for example a platform load balancer); BFF traffic uses the proxy secret.
    trustProxy: trustProxyHops(config.TRUST_PROXY),
  });
  const securityHeaders = apiSecurityHeaders(config.NODE_ENV === "production");

  // Registered before any scope so admin, webhook and auth routes all inherit them.
  app.addHook("onRequest", async (request) => {
    pinClientIp(request, config.INTERNAL_PROXY_SECRET);
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    applySecurityHeaders(reply, securityHeaders);
    return payload;
  });
  app.setErrorHandler(sendUnhandledError);
  app.setNotFoundHandler(sendNotFound);
  // Fails boot in production without MANDATE_SIGNING_KEY; dev/test warn once and use a temporary key.
  await configureMandateSigning(
    {
      signingKey: config.MANDATE_SIGNING_KEY,
      previousJwks: config.MANDATE_SIGNING_PREVIOUS_JWKS,
      issuer: config.API_URL,
      nodeEnv: config.NODE_ENV,
    },
    app.log,
  );
  registerPublicCredentialRoutes(app);

  await app.register(cors, {
    origin: [
      ...new Set([
        ...originsFor(config.WEB_ORIGIN, config.NODE_ENV),
        ...originsFor(config.ADMIN_ORIGIN, config.NODE_ENV),
      ]),
    ],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "accept",
      "content-type",
      "origin",
      "cookie",
      "authorization",
      "x-request-id",
      "x-correlation-id",
    ],
    exposedHeaders: ["x-request-id", "x-correlation-id"],
  });

  const probePaypal =
    options.probePaypal ??
    (paypal && typeof paypal.probeSandbox === "function" ? () => paypal.probeSandbox() : undefined);
  const probeChannel3 =
    options.probeChannel3 ??
    (config.CHANNEL3_API_KEY
      ? async () => {
          const started = Date.now();
          try {
            await new Channel3Client(
              parseChannel3Config({
                apiKey: config.CHANNEL3_API_KEY,
                timeoutMs: 5_000,
                maxRetries: 0,
                fallbackMode: "disabled",
              }),
            ).probeConnectivity();
            return {
              status: "ready" as const,
              code: "CHANNEL3_REACHABLE",
              latencyMs: Date.now() - started,
            };
          } catch (error) {
            const latencyMs = Date.now() - started;
            if (error instanceof Channel3ProviderError) {
              const degraded =
                error.code === "UPSTREAM_TIMEOUT" ||
                error.code === "UPSTREAM_ABORTED" ||
                error.code === "UPSTREAM_UNAVAILABLE" ||
                error.status === 429;
              return {
                status: degraded ? ("degraded" as const) : ("unavailable" as const),
                code: error.status === 429 ? "UPSTREAM_UNAVAILABLE" : error.code,
                latencyMs,
              };
            }
            if (isChannel3Error(error) && !(error instanceof Channel3ConfigurationError)) {
              return { status: "unavailable" as const, code: error.code, latencyMs };
            }
            return { status: "unavailable" as const, code: "PROBE_FAILED", latencyMs };
          }
        }
      : undefined);
  registerAdminRoutes(app, {
    runtime,
    appUrl: config.APP_URL,
    adminOrigin: config.ADMIN_ORIGIN,
    nodeEnv: config.NODE_ENV,
    discoveryMode: config.PRODUCT_DISCOVERY_MODE,
    paypalConfigured: paypal !== null,
    channel3Configured: Boolean(config.CHANNEL3_API_KEY),
    probePaypal,
    probeChannel3,
    readMaximum: options.testAdminReadMaximum,
    mutationMaximum: options.testAdminMutationMaximum,
    financialMaximum: options.testAdminFinancialMaximum,
    getPaypal: () => paypal,
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "mandatepay-api",
    stage: "mvp",
    productDiscoveryMode: config.PRODUCT_DISCOVERY_MODE,
  }));

  app.get("/health/ready", async (_request, reply) => {
    if (!runtime) {
      return reply.status(503).send({
        status: "unavailable",
        service: "mandatepay-api",
        stage: "auth",
        code: "AUTH_UNAVAILABLE",
      });
    }
    try {
      await runtime.database.$queryRawUnsafe("SELECT 1");
      return {
        status: "ready",
        service: "mandatepay-api",
        stage: "auth",
      };
    } catch {
      return reply.status(503).send({
        status: "unavailable",
        service: "mandatepay-api",
        stage: "auth",
        code: "DATABASE_UNAVAILABLE",
      });
    }
  });

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    preHandler: async (request, reply) => {
      if (request.method !== "POST") return;
      const now = Date.now();
      const email = credentialAttemptEmail(request.method, request.url, request.body);
      const addressRate = consumeAuthPost(request.ip || "unknown", now);
      const rate = addressRate.allowed && email ? consumeCredentialEmail(email, now) : addressRate;
      if (rate.allowed) return;
      reply.header("retry-after", rate.retryAfter.toString());
      return reply.status(429).send({
        error: "Too many authentication attempts. Try again shortly.",
        code: "AUTH_RATE_LIMITED",
      });
    },
    handler: async (request, reply) => {
      if (!runtime) return sendUnavailable(reply);
      const path = request.url.split("?")[0] ?? "";
      if (request.method === "POST" && path.endsWith("/sign-up/email")) {
        try {
          await assertRegistrationOpen(runtime.database);
        } catch (error) {
          if (error instanceof PlatformControlDenied)
            return reply.status(error.httpStatus).send({ error: error.message, code: error.code });
          return reply.status(503).send({
            error: "New account registration is temporarily unavailable.",
            code: "REGISTRATION_DISABLED",
          });
        }
      }
      try {
        const response = await runtime.auth.handler(buildAuthRequest(request, config));
        return rejectDisabledCredentialSession(runtime, request, reply, response);
      } catch {
        request.log.error(
          {
            event: "auth_request_failed",
            method: request.method,
            path: safeRequestPath(request.url),
          },
          "Authentication handler failed",
        );
        return sendUnavailable(reply);
      }
    },
  });

  app.get("/api/me", async (request, reply) => {
    if (!runtime) return sendUnavailable(reply);
    const user = await readAuthenticatedUser(request, runtime, reply);
    if (!user) return;
    return reply.send({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        autonomousPurchasingEnabled: user.globalAutonomousPurchasingEnabled,
      },
    });
  });

  app.patch("/api/settings", async (request, reply) => {
    if (!runtime) return sendUnavailable(reply);
    if (!isTrustedOrigin(request.headers.origin, config)) {
      return reply.status(403).send({
        error: "Request origin is not trusted.",
        code: "ORIGIN_NOT_TRUSTED",
      });
    }

    const user = await readAuthenticatedUser(request, runtime, reply);
    if (!user) return;
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid settings request.",
        code: "INVALID_REQUEST",
      });
    }

    try {
      const updated = await runtime.database.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', user.id);
        const current = await tx.user.findUnique({
          where: { id: user.id },
          select: { id: true, globalAutonomousPurchasingEnabled: true },
        });
        if (!current) return null;
        const next = parsed.data.autonomousPurchasingEnabled;
        if (current.globalAutonomousPurchasingEnabled === next) {
          return {
            id: current.id,
            autonomousPurchasingEnabled: next,
            changed: false,
          };
        }

        await tx.user.update({
          where: { id: current.id },
          data: { globalAutonomousPurchasingEnabled: next },
        });
        await tx.auditEvent.create({
          data: {
            userId: current.id,
            eventType: "GLOBAL_AUTONOMY_UPDATED",
            entityType: "USER",
            entityId: current.id,
            payload: {
              previous: current.globalAutonomousPurchasingEnabled,
              next,
              source: "settings",
            },
          },
        });
        return {
          id: current.id,
          autonomousPurchasingEnabled: next,
          changed: true,
        };
      });

      if (!updated) {
        return reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
      }
      return reply.send({
        user: {
          id: updated.id,
          autonomousPurchasingEnabled: updated.autonomousPurchasingEnabled,
        },
        changed: updated.changed,
      });
    } catch {
      request.log.error(
        { event: "settings_update_failed", path: request.url },
        "Settings update failed",
      );
      return sendUnavailable(reply);
    }
  });

  if (runtime) {
    const consumeMutation = createMutationRateLimiter();
    const modelConfig = () =>
      loadOpenAIConfig({
        OPENAI_API_KEY: config.OPENAI_API_KEY,
        OPENAI_MODEL: config.OPENAI_MODEL,
        OPENAI_BASE_URL: config.OPENAI_BASE_URL,
        OPENAI_RESPONSE_MODE: process.env.OPENAI_RESPONSE_MODE,
        OPENAI_MAX_OUTPUT_TOKENS: process.env.OPENAI_MAX_OUTPUT_TOKENS,
        OPENAI_REASONING_EFFORT: process.env.OPENAI_REASONING_EFFORT,
        OPENAI_MAX_RETRIES: "0",
      });
    const gatewayPrincipals = createGatewayPrincipals();
    const protectedContext = {
      database: runtime.database,
      requireUser: async (request: FastifyRequest, reply: FastifyReply) => {
        const user =
          request.headers[GATEWAY_PRINCIPAL_HEADER] === undefined
            ? await readAuthenticatedUser(request, runtime, reply)
            : await readGatewayPrincipalUser(request, runtime, reply, gatewayPrincipals);
        if (!user || !isFinancialMutation(request.method, request.url)) return user;
        const rate = consumeMutation(user.id);
        if (rate.allowed) return user;
        await reply
          .header("retry-after", rate.retryAfter)
          .status(429)
          .send({ error: "Too many purchase actions. Try again shortly." });
        return null;
      },
      isTrustedOrigin: (origin: string | undefined) => isTrustedOrigin(origin, config),
    };
    registerProposalRoutes(app, protectedContext);
    registerShoppingAgentRoutes(app, {
      ...protectedContext,
      app,
      appUrl: config.APP_URL,
      modelId: config.OPENAI_MODEL,
      productContextSecret: config.AUTH_SECRET
        ? deriveProductContextSecret(config.AUTH_SECRET)
        : undefined,
      runner: (input, tools, options) =>
        runShoppingAgent(input, { config: modelConfig(), tools, ...options }),
    });
    registerAnalyticsRoutes(app, {
      ...protectedContext,
      parseQuery: (request) =>
        parseAnalyticsQuery(request, { config: { ...modelConfig(), maxOutputTokens: 768 } }),
    });
    registerPayPalRoutes(app, {
      ...protectedContext,
      paypal,
      appUrl: config.APP_URL,
      lookupDemoProduct: async (externalId) => lookupDemoProduct(externalId),
      paypalStatus: {
        configured: paypal !== null,
        environment: paypal?.config.environment ?? config.PAYPAL_ENV,
        webhookConfigured: Boolean(paypal?.config.webhookId),
      },
    });
    registerRefundRoutes(app, { ...protectedContext, paypal });
    // Saved PayPal (Vault) stays off unless TOKEN_ENCRYPTION_KEY is a valid 32-byte key.
    const vaultCipher = createVaultCipher(config.TOKEN_ENCRYPTION_KEY);
    if (paypal && !vaultCipher) {
      app.log.warn(
        { event: "paypal_vault_disabled" },
        "Saved PayPal payments are disabled: TOKEN_ENCRYPTION_KEY is missing or not 32 bytes.",
      );
    }
    registerPaymentMethodRoutes(app, {
      ...protectedContext,
      paypal,
      vault: vaultCipher,
      appUrl: config.APP_URL,
      lookupDemoProduct: async (externalId) => lookupDemoProduct(externalId),
    });
    if (paypal) {
      registerPayPalWebhookRoutes(
        app,
        createPayPalWebhookService(runtime.database, paypal, { vaultCipher }),
        {
          recordDelivery: (fact) =>
            new ObservabilityRepository(runtime.database).recordWebhookDelivery(fact),
        },
      );
    } else {
      app.post("/api/webhooks/paypal", async (_request, reply) =>
        reply.status(503).send({ error: "PayPal webhooks are not configured." }),
      );
    }
    registerCatalogRoutes(app, {
      ...protectedContext,
      mode: config.PRODUCT_DISCOVERY_MODE,
      channel3:
        config.PRODUCT_DISCOVERY_MODE === "channel3"
          ? createChannel3CatalogClient(config.CHANNEL3_API_KEY)
          : undefined,
      // Labeled Demo Catalog results when live discovery is missing, failing or timing out.
      channel3Fallback: channel3FallbackMode(process.env.CHANNEL3_FALLBACK_MODE),
      rank: (mandate, products) =>
        rankProducts({ mandate, candidates: products }, { config: modelConfig() }),
    });
    registerMandateRoutes(app, {
      ...protectedContext,
      parseDraft: (request) =>
        parseMandate(request, {
          config: modelConfig(),
        }),
    });
    registerSimulatorRoutes(app, protectedContext);
    registerCredentialRoutes(app, protectedContext);
    const agentTokenKey = config.AUTH_SECRET ? deriveAgentTokenKey(config.AUTH_SECRET) : null;
    registerAgentTokenRoutes(app, {
      ...protectedContext,
      tokenKey: agentTokenKey,
      apiUrl: config.API_URL,
    });
    // External agents (MCP) authenticate with a bearer agent token only; no cookies are read.
    registerAgentGatewayRoutes(app, {
      database: runtime.database,
      tokenKey: agentTokenKey,
      appUrl: config.APP_URL,
      payments: {
        database: runtime.database,
        paypal,
        appUrl: config.APP_URL,
        lookupDemoProduct: async (externalId) => lookupDemoProduct(externalId),
        vault: vaultCipher,
      },
      internal: async (userId, { url, payload, headers = {} }) => {
        const response = await app.inject({
          method: "POST",
          url,
          headers: {
            ...headers,
            origin: config.APP_URL,
            "content-type": "application/json",
            [GATEWAY_PRINCIPAL_HEADER]: gatewayPrincipals.issue(userId),
          },
          payload: JSON.stringify(payload),
        });
        let body: unknown = null;
        try {
          body = JSON.parse(response.body) as unknown;
        } catch {
          body = null;
        }
        return { statusCode: response.statusCode, body };
      },
    });
    app.addHook("onClose", async () => {
      await runtime.close();
    });
  }

  return app;
}
