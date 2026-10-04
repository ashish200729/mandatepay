import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { fromNodeHeaders } from "better-auth/node";
import type { DatabaseClient } from "@mandatepay/database";
import { z } from "zod";
import { createAuthRuntime, type AuthRuntime } from "./auth.js";
import { env } from "./env.js";
import {
  loadOpenAIConfig,
  parseMandate,
  rankProducts,
  parseAnalyticsQuery,
  runShoppingAgent,
} from "@mandatepay/agent";
import { Channel3Client, parseChannel3Config, lookupDemoProduct } from "@mandatepay/channel3";
import type { PayPalClient } from "@mandatepay/paypal";
import { registerMandateRoutes } from "./routes/mandates.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerProposalRoutes } from "./routes/proposals.js";
import { registerPayPalRoutes } from "./routes/paypal.js";
import { registerRefundRoutes } from "./routes/refunds.js";
import { createPayPalClientFromEnvironment } from "./services/payments.js";
import { createPayPalWebhookService } from "./services/webhooks.js";
import { registerPayPalWebhookRoutes } from "./routes/webhooks.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerShoppingAgentRoutes } from "./routes/agent.js";
import {
  createMutationRateLimiter,
  isFinancialMutation,
  safeRequestPath,
} from "./services/rate-limits.js";

const settingsSchema = z
  .object({
    autonomousPurchasingEnabled: z.boolean(),
  })
  .strict();

const authPostWindowMs = 60_000;
const authPostMaxRequests = 30;

type RuntimeConfig = typeof env;

export interface CreateAppOptions {
  config?: RuntimeConfig;
  authRuntime?: AuthRuntime | null;
  database?: DatabaseClient;
  /** Programmatic test dependency. HTTP clients cannot configure this. */
  paypalClient?: PayPalClient | null;
  /** Isolated test servers can provision many fixture accounts from loopback. */
  testAuthPostMaximum?: number;
}

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

function isTrustedOrigin(origin: string | undefined, config: RuntimeConfig): boolean {
  if (!origin) return false;
  try {
    const requestOrigin = new URL(origin).origin;
    const configuredOrigin = new URL(config.APP_URL).origin;
    if (requestOrigin === configuredOrigin) return true;
    if (config.NODE_ENV === "production") return false;
    const configured = new URL(config.APP_URL);
    if (configured.hostname !== "localhost" && configured.hostname !== "127.0.0.1") {
      return false;
    }
    const alias = configured.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const port = configured.port ? ":" + configured.port : "";
    return requestOrigin === configured.protocol + "//" + alias + port;
  } catch {
    return false;
  }
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
      nodeEnv: config.NODE_ENV,
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

    const user = await runtime.database.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        globalAutonomousPurchasingEnabled: true,
      },
    });
    if (!user) {
      await reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
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

function buildAuthRequest(request: FastifyRequest, config: RuntimeConfig): Request {
  const url = new URL(request.url, config.APP_URL);
  const headers = fromNodeHeaders(request.headers);
  headers.delete("content-length");
  headers.delete("host");
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
    options.testAuthPostMaximum !== undefined &&
    (config.NODE_ENV !== "test" ||
      !Number.isSafeInteger(options.testAuthPostMaximum) ||
      options.testAuthPostMaximum < 1 ||
      options.testAuthPostMaximum > 500)
  ) {
    throw new Error("Authentication fixture limits are supported only by isolated test servers.");
  }
  const maximumAuthRequests = options.testAuthPostMaximum ?? authPostMaxRequests;
  const runtime = resolveAuthRuntime(options, config);
  const authPostRateLimits = new Map<string, RateLimitEntry>();
  const app = Fastify({
    logger: safeLoggerConfig(config),
  });

  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["accept", "content-type", "origin", "cookie", "authorization", "x-request-id"],
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
      for (const [address, entry] of authPostRateLimits) {
        if (entry.resetAt <= now) authPostRateLimits.delete(address);
      }
      if (authPostRateLimits.size >= 4096 && !authPostRateLimits.has(request.ip)) {
        return reply.status(429).send({
          error: "Too many authentication attempts. Try again shortly.",
          code: "AUTH_RATE_LIMITED",
        });
      }
      const key = request.ip || "unknown";
      const current = authPostRateLimits.get(key);
      if (!current || current.resetAt <= now) {
        authPostRateLimits.set(key, { count: 1, resetAt: now + authPostWindowMs });
        return;
      }
      if (current.count >= maximumAuthRequests) {
        reply.header("retry-after", Math.ceil((current.resetAt - now) / 1000).toString());
        return reply.status(429).send({
          error: "Too many authentication attempts. Try again shortly.",
          code: "AUTH_RATE_LIMITED",
        });
      }
      current.count += 1;
    },
    handler: async (request, reply) => {
      if (!runtime) return sendUnavailable(reply);
      try {
        const response = await runtime.auth.handler(buildAuthRequest(request, config));
        return forwardAuthResponse(response, reply);
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
    const paypal =
      options.paypalClient !== undefined
        ? options.paypalClient
        : createPayPalClientFromEnvironment(config);
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
    const protectedContext = {
      database: runtime.database,
      requireUser: async (request: FastifyRequest, reply: FastifyReply) => {
        const user = await readAuthenticatedUser(request, runtime, reply);
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
      productContextSecret: config.AUTH_SECRET,
      runner: (input, tools) => runShoppingAgent(input, { config: modelConfig(), tools }),
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
        environment: "sandbox",
        webhookConfigured: Boolean(paypal?.config.webhookId),
      },
    });
    registerRefundRoutes(app, { ...protectedContext, paypal });
    if (paypal) {
      registerPayPalWebhookRoutes(app, createPayPalWebhookService(runtime.database, paypal));
    } else {
      app.post("/api/webhooks/paypal", async (_request, reply) =>
        reply.status(503).send({ error: "PayPal webhooks are not configured." }),
      );
    }
    registerCatalogRoutes(app, {
      ...protectedContext,
      mode: config.PRODUCT_DISCOVERY_MODE,
      channel3:
        config.PRODUCT_DISCOVERY_MODE === "channel3" && config.CHANNEL3_API_KEY
          ? new Channel3Client(parseChannel3Config({ apiKey: config.CHANNEL3_API_KEY }))
          : undefined,
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
    app.addHook("onClose", async () => {
      await runtime.close();
    });
  }

  return app;
}
