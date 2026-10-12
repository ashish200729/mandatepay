import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DatabaseError, type DatabaseClient } from "@mandatepay/database";
import { z } from "zod";
import {
  MAX_CREDENTIAL_LENGTH,
  mandateKeyring,
  publicJwks,
  readMandateCredentials,
  readProposalCredentials,
  verifyMandateCredential,
} from "../services/mandate-credentials.js";
import { createFixedWindowRateLimiter } from "../services/rate-limits.js";

type AuthenticatedUser = { id: string };

export interface CredentialRouteContext {
  database: DatabaseClient;
  requireUser: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<AuthenticatedUser | null | undefined>;
}

const idSchema = z.object({ id: z.string().trim().min(1).max(255) });
const verifyBodySchema = z.union([
  z.string().trim().min(1).max(MAX_CREDENTIAL_LENGTH),
  z
    .object({ credential: z.string().trim().min(1).max(MAX_CREDENTIAL_LENGTH) })
    .strict()
    .transform((body) => body.credential),
]);

const JWKS_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=60";

function idOf(request: FastifyRequest) {
  const parsed = idSchema.safeParse(request.params);
  return parsed.success ? parsed.data.id : null;
}

function credentialError(reply: FastifyReply, cause: unknown, subject: "Mandate" | "Proposal") {
  if (cause instanceof DatabaseError) {
    if (cause.code === "NOT_FOUND") {
      return reply.status(404).send({ error: `${subject} not found.`, code: "NOT_FOUND" });
    }
    if (cause.code === "INVALID_STATE") {
      return reply.status(409).send({
        error: `${subject} credentials cannot be produced in its current state.`,
        code: "INVALID_STATE",
      });
    }
  }
  return reply.status(503).send({
    error: "Mandate credentials are temporarily unavailable.",
    code: "CREDENTIALS_UNAVAILABLE",
  });
}

/** Public, unauthenticated: the JWKS and stateless verification with public keys only. */
export function registerPublicCredentialRoutes(
  app: FastifyInstance,
  options: { verifyMaximum?: number } = {},
) {
  const consumeVerify = createFixedWindowRateLimiter({
    maximum: options.verifyMaximum ?? 30,
    windowMs: 60_000,
    capacity: 4_096,
  });

  const sendJwks = async (_request: FastifyRequest, reply: FastifyReply) => {
    const keyring = await mandateKeyring();
    // Public keys only: any party may fetch them to verify a MandatePay credential.
    return reply
      .header("cache-control", JWKS_CACHE_CONTROL)
      .header("access-control-allow-origin", "*")
      .header("cross-origin-resource-policy", "cross-origin")
      .send(publicJwks(keyring));
  };
  app.get("/.well-known/jwks.json", sendJwks);
  // Same document under /api so the web BFF can expose it on the app origin.
  app.get("/api/credentials/jwks", sendJwks);

  app.post("/api/credentials/verify", async (request, reply) => {
    const rate = consumeVerify(request.ip || "unknown");
    if (!rate.allowed) {
      reply.header("retry-after", rate.retryAfter.toString());
      return reply
        .status(429)
        .send({ error: "Too many verification requests.", code: "RATE_LIMITED" });
    }
    const parsed = verifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: "Send a compact JWS credential.", code: "INVALID_REQUEST" });
    }
    const keyring = await mandateKeyring();
    const result = await verifyMandateCredential(keyring, parsed.data);
    return reply.header("cache-control", "no-store").send(result);
  });
}

export function registerCredentialRoutes(app: FastifyInstance, context: CredentialRouteContext) {
  app.get("/api/mandates/:id/credentials", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const id = idOf(request);
    if (!id)
      return reply.status(400).send({ error: "Mandate id is invalid.", code: "INVALID_REQUEST" });
    try {
      return reply
        .header("cache-control", "private, no-store")
        .send(await readMandateCredentials(context.database, user.id, id));
    } catch (error) {
      return credentialError(reply, error, "Mandate");
    }
  });

  app.get("/api/proposals/:id/credentials", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const id = idOf(request);
    if (!id) {
      return reply.status(400).send({ error: "Proposal id is invalid.", code: "INVALID_REQUEST" });
    }
    try {
      return reply
        .header("cache-control", "private, no-store")
        .send(await readProposalCredentials(context.database, user.id, id));
    } catch (error) {
      return credentialError(reply, error, "Proposal");
    }
  });
}
