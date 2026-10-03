import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseClient } from "@mandatepay/database";
import { DatabaseError, MandateRepository } from "@mandatepay/database";
import { CanonicalMandateSchema } from "@mandatepay/shared";
import { z } from "zod";
import {
  canonicalToCreateInput,
  normalizeDraftResult,
  toMandateDTO,
  type DraftParser,
} from "../services/mandates.js";

type AuthenticatedUser = { id: string };

export interface MandateRouteContext {
  database: DatabaseClient;
  requireUser: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<AuthenticatedUser | null | undefined>;
  isTrustedOrigin: (origin: string | undefined) => boolean;
  parseDraft: DraftParser;
}

const parseBodySchema = z.object({ prompt: z.string().trim().min(1).max(12_000) }).strict();
const createBodySchema = z
  .object({
    originalPrompt: z.string().trim().min(1).max(20_000),
    mandate: CanonicalMandateSchema,
    requestKey: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
const patchBodySchema = z
  .object({
    version: z.number().int().positive(),
    originalPrompt: z.string().trim().min(1).max(20_000),
    mandate: CanonicalMandateSchema,
  })
  .strict();
const actionBodySchema = z.object({ version: z.number().int().positive() }).strict();
const idSchema = z.object({ id: z.string().trim().min(1).max(255) });

type RateLimitEntry = { count: number; resetAt: number };

function jsonError(reply: FastifyReply, statusCode: number, code: string, error: string) {
  return reply.status(statusCode).send({ error, code });
}

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof DatabaseError) {
    if (error.code === "NOT_FOUND") return jsonError(reply, 404, error.code, "Mandate not found.");
    if (error.code === "CONFLICT") {
      return jsonError(reply, 409, error.code, "Mandate changed; refresh and try again.");
    }
    if (
      error.code === "INVALID_DOMAIN_INPUT" ||
      error.code === "INVALID_DATE_RANGE" ||
      error.code === "INVALID_CURRENCY" ||
      error.code === "INVALID_MONEY"
    ) {
      return jsonError(reply, 400, error.code, "Mandate request is invalid.");
    }
    if (error.code === "INVALID_STATE") {
      return jsonError(reply, 409, error.code, "Mandate is not in a valid state for this action.");
    }
  }
  return jsonError(
    reply,
    503,
    "MANDATE_UNAVAILABLE",
    "Mandate service is temporarily unavailable.",
  );
}

function handleParserError(reply: FastifyReply, error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (
    code === "INVALID_PROMPT" ||
    code === "INVALID_TRUSTED_TIME" ||
    code === "CANONICAL_VALIDATION_FAILED"
  ) {
    return jsonError(reply, 400, code, "Mandate prompt is invalid.");
  }
  return jsonError(reply, 503, "PARSER_UNAVAILABLE", "Mandate parser is temporarily unavailable.");
}

function originHeader(request: FastifyRequest): string | undefined {
  const value = request.headers.origin;
  return Array.isArray(value) ? value[0] : value;
}

function paramsId(request: FastifyRequest): string | null {
  const parsed = idSchema.safeParse(request.params);
  return parsed.success ? parsed.data.id : null;
}

function rateLimited(
  limits: Map<string, RateLimitEntry>,
  userId: string,
): { retryAfter: number } | null {
  const now = Date.now();
  for (const [key, entry] of limits) {
    if (entry.resetAt <= now) limits.delete(key);
  }
  if (limits.size > 2048) {
    const oldest = [...limits.entries()].sort((left, right) => left[1].resetAt - right[1].resetAt);
    for (const [key] of oldest.slice(0, limits.size - 2048)) limits.delete(key);
  }
  const current = limits.get(userId);
  if (!current || current.resetAt <= now) {
    limits.set(userId, { count: 1, resetAt: now + 60_000 });
    return null;
  }
  if (current.count >= 10) {
    return { retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  current.count += 1;
  return null;
}

export function registerMandateRoutes(app: FastifyInstance, context: MandateRouteContext) {
  const parserLimits = new Map<string, RateLimitEntry>();
  const repository = () => new MandateRepository(context.database);

  app.post("/api/mandates/parse", async (request, reply) => {
    if (!context.isTrustedOrigin(originHeader(request))) {
      return jsonError(reply, 403, "ORIGIN_NOT_TRUSTED", "Request origin is not trusted.");
    }
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const limit = rateLimited(parserLimits, user.id);
    if (limit) {
      reply.header("retry-after", limit.retryAfter.toString());
      return jsonError(reply, 429, "RATE_LIMITED", "Too many mandate parsing requests.");
    }
    const parsed = parseBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return jsonError(reply, 400, "INVALID_REQUEST", "Mandate prompt is invalid.");
    }
    try {
      return reply.send(
        normalizeDraftResult(
          await context.parseDraft(
            { prompt: parsed.data.prompt, now: new Date().toISOString() },
            user.id,
          ),
          parsed.data.prompt,
        ),
      );
    } catch (error) {
      return handleParserError(reply, error);
    }
  });

  app.post("/api/mandates", async (request, reply) => {
    if (!context.isTrustedOrigin(originHeader(request))) {
      return jsonError(reply, 403, "ORIGIN_NOT_TRUSTED", "Request origin is not trusted.");
    }
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return jsonError(reply, 400, "INVALID_REQUEST", "Mandate request is invalid.");
    }
    try {
      const mandate = await repository().create(
        canonicalToCreateInput(
          user.id,
          parsed.data.originalPrompt,
          parsed.data.mandate,
          parsed.data.requestKey,
        ),
      );
      return reply.status(201).send({ mandate: toMandateDTO(mandate) });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get("/api/mandates", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    try {
      const mandates = await repository().listForUser(user.id);
      return reply.send({ mandates: mandates.map(toMandateDTO) });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get("/api/mandates/:id", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const id = paramsId(request);
    if (!id) return jsonError(reply, 400, "INVALID_REQUEST", "Mandate id is invalid.");
    try {
      const mandate = await repository().getByIdForUser(id, user.id);
      return reply.send({ mandate: toMandateDTO(mandate) });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.patch("/api/mandates/:id", async (request, reply) => {
    if (!context.isTrustedOrigin(originHeader(request))) {
      return jsonError(reply, 403, "ORIGIN_NOT_TRUSTED", "Request origin is not trusted.");
    }
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const id = paramsId(request);
    const parsed = patchBodySchema.safeParse(request.body);
    if (!id || !parsed.success) {
      return jsonError(reply, 400, "INVALID_REQUEST", "Mandate update is invalid.");
    }
    try {
      const mandate = await repository().createVersion(
        id,
        user.id,
        canonicalToCreateInput(user.id, parsed.data.originalPrompt, parsed.data.mandate),
        parsed.data.version,
      );
      return reply.send({ mandate: toMandateDTO(mandate) });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  const registerAction = (action: "activate" | "pause" | "resume" | "revoke") => {
    app.post("/api/mandates/:id/" + action, async (request, reply) => {
      if (!context.isTrustedOrigin(originHeader(request))) {
        return jsonError(reply, 403, "ORIGIN_NOT_TRUSTED", "Request origin is not trusted.");
      }
      const user = await context.requireUser(request, reply);
      if (!user) return;
      const id = paramsId(request);
      const parsed = actionBodySchema.safeParse(request.body);
      if (!id || !parsed.success) {
        return jsonError(reply, 400, "INVALID_REQUEST", "Mandate action request is invalid.");
      }
      try {
        const mandate = await repository()[action](id, user.id, parsed.data.version);
        return reply.send({ mandate: toMandateDTO(mandate) });
      } catch (error) {
        return handleError(reply, error);
      }
    });
  };

  registerAction("activate");
  registerAction("pause");
  registerAction("resume");
  registerAction("revoke");
}
