import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabaseClient } from "@mandatepay/database";
import {
  AgentTokenError,
  CreateAgentTokenSchema,
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
} from "../services/agent-tokens.js";
import { createFixedWindowRateLimiter } from "../services/rate-limits.js";

type AuthenticatedUser = { id: string };

export interface AgentTokenRouteContext {
  readonly database: DatabaseClient;
  /** HKDF-derived HMAC key; null when AUTH_SECRET is missing, which disables token creation. */
  readonly tokenKey: Buffer | null;
  /** Public API base URL, used to show the agent gateway address. */
  readonly apiUrl: string;
  readonly requireUser: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<AuthenticatedUser | null | undefined>;
  readonly isTrustedOrigin: (origin: string | undefined) => boolean;
}

const emptyBodySchema = z.object({}).strict();
const idSchema = z.object({ id: z.string().trim().min(1).max(255) });

function originOf(request: FastifyRequest) {
  const value = request.headers.origin;
  return Array.isArray(value) ? value[0] : value;
}

export function agentGatewayBaseUrl(apiUrl: string) {
  return `${apiUrl.replace(/\/+$/u, "")}/api/agent-gateway/v1`;
}

function sendError(reply: FastifyReply, cause: unknown) {
  if (cause instanceof AgentTokenError) {
    return reply.status(cause.httpStatus).send({ error: cause.message, code: cause.code });
  }
  return reply
    .status(503)
    .send({ error: "Agent connections are temporarily unavailable.", code: "UNAVAILABLE" });
}

/**
 * Customer-managed agent access tokens (cookie session). The plaintext token is
 * returned once, at creation; afterwards only its display prefix is shown.
 */
export function registerAgentTokenRoutes(app: FastifyInstance, context: AgentTokenRouteContext) {
  const consumeChange = createFixedWindowRateLimiter({
    maximum: 20,
    windowMs: 60_000,
    capacity: 2_048,
  });
  const gateway = { baseUrl: agentGatewayBaseUrl(context.apiUrl) };

  async function mutationUser(request: FastifyRequest, reply: FastifyReply) {
    if (!context.isTrustedOrigin(originOf(request))) {
      await reply
        .status(403)
        .send({ error: "Request origin is not trusted.", code: "ORIGIN_NOT_TRUSTED" });
      return null;
    }
    const user = await context.requireUser(request, reply);
    if (!user) return null;
    const rate = consumeChange(user.id);
    if (!rate.allowed) {
      await reply.header("retry-after", rate.retryAfter).status(429).send({
        error: "Too many agent connection changes. Try again shortly.",
        code: "RATE_LIMITED",
      });
      return null;
    }
    return user;
  }

  app.get("/api/agent-tokens", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    try {
      return reply.send({
        agentTokens: await listAgentTokens(context.database, user.id),
        gateway,
        available: context.tokenKey !== null,
      });
    } catch (cause) {
      return sendError(reply, cause);
    }
  });

  app.post("/api/agent-tokens", async (request, reply) => {
    const user = await mutationUser(request, reply);
    if (!user) return;
    const parsed = CreateAgentTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error:
          "Give the connection a short name, choose READ plus any other scopes (AUTOPAY needs PROPOSE) and an expiry of 7, 30 or 90 days.",
        code: "INVALID_REQUEST",
      });
    }
    if (!context.tokenKey) {
      return reply.status(503).send({
        error: "Agent connections are not configured on this server.",
        code: "UNAVAILABLE",
      });
    }
    try {
      const created = await createAgentToken(
        context.database,
        context.tokenKey,
        user.id,
        parsed.data,
      );
      // The response carries the only copy of the token; never cache it.
      reply.header("cache-control", "no-store");
      return reply.status(201).send({ ...created, gateway });
    } catch (cause) {
      return sendError(reply, cause);
    }
  });

  app.post("/api/agent-tokens/:id/revoke", async (request, reply) => {
    const user = await mutationUser(request, reply);
    if (!user) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success || !emptyBodySchema.safeParse(request.body ?? {}).success) {
      return reply
        .status(400)
        .send({ error: "Revoke request is invalid.", code: "INVALID_REQUEST" });
    }
    try {
      return reply.send({
        agentToken: await revokeAgentToken(context.database, user.id, params.data.id),
      });
    } catch (cause) {
      return sendError(reply, cause);
    }
  });
}
