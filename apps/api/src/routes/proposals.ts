import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DatabaseError, type DatabaseClient } from "@mandatepay/database";
import {
  evaluateProposal,
  getProposal,
  listApprovals,
  listProposals,
  approveProposal,
  rejectProposal,
} from "../services/proposals.js";

type AuthenticatedUser = { id: string };

export interface ProposalRouteContext {
  database: DatabaseClient;
  requireUser: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<AuthenticatedUser | null | undefined>;
  isTrustedOrigin: (origin: string | undefined) => boolean;
}

const emptySchema = z.object({}).strict();
const idSchema = z.object({ id: z.string().trim().min(1).max(255) });

function originOf(request: FastifyRequest) {
  const value = request.headers.origin;
  return Array.isArray(value) ? value[0] : value;
}

function error(reply: FastifyReply, cause: unknown) {
  if (cause instanceof DatabaseError) {
    if (cause.code === "NOT_FOUND") return reply.status(404).send({ error: "Proposal not found." });
    if (cause.code === "CONFLICT") {
      return reply.status(409).send({ error: "Proposal is stale or conflicted." });
    }
    if (cause.code === "INVALID_DOMAIN_INPUT" || cause.code === "INVALID_MONEY") {
      return reply.status(400).send({ error: "Proposal request is invalid." });
    }
    if (cause.code === "INVALID_STATE" || cause.code === "LIMIT_EXCEEDED") {
      return reply
        .status(409)
        .send({ error: "Proposal cannot be processed in its current state." });
    }
  }
  return reply.status(503).send({ error: "Proposal service is temporarily unavailable." });
}

function idOf(request: FastifyRequest) {
  const parsed = idSchema.safeParse(request.params);
  return parsed.success ? parsed.data.id : null;
}

export function registerProposalRoutes(app: FastifyInstance, context: ProposalRouteContext) {
  app.get("/api/proposals", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    try {
      return reply.send(await listProposals(context.database, user));
    } catch (cause) {
      return error(reply, cause);
    }
  });

  app.get("/api/approvals", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    try {
      return reply.send(await listApprovals(context.database, user));
    } catch (cause) {
      return error(reply, cause);
    }
  });

  app.get("/api/proposals/:id", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const id = idOf(request);
    if (!id) return reply.status(400).send({ error: "Proposal id is invalid." });
    try {
      return reply.send(await getProposal(context.database, user, id));
    } catch (cause) {
      return error(reply, cause);
    }
  });

  app.post("/api/proposals/:id/evaluate", async (request, reply) => {
    if (!context.isTrustedOrigin(originOf(request))) {
      return reply.status(403).send({ error: "Request origin is not trusted." });
    }
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const id = idOf(request);
    if (!id || !emptySchema.safeParse(request.body ?? {}).success) {
      return reply.status(400).send({ error: "Evaluation request is invalid." });
    }
    try {
      return reply.send(await evaluateProposal(context.database, user, id));
    } catch (cause) {
      return error(reply, cause);
    }
  });

  const registerApprovalAction = (action: "approve" | "reject") => {
    app.post("/api/proposals/:id/" + action, async (request, reply) => {
      if (!context.isTrustedOrigin(originOf(request))) {
        return reply.status(403).send({ error: "Request origin is not trusted." });
      }
      const user = await context.requireUser(request, reply);
      if (!user) return;
      const id = idOf(request);
      if (!id || !emptySchema.safeParse(request.body ?? {}).success) {
        return reply.status(400).send({ error: "Approval request is invalid." });
      }
      try {
        const result =
          action === "approve"
            ? await approveProposal(context.database, user, id)
            : await rejectProposal(context.database, user, id);
        return reply.status("expired" in result && result.expired ? 409 : 200).send(result);
      } catch (cause) {
        return error(reply, cause);
      }
    });
  };

  registerApprovalAction("approve");
  registerApprovalAction("reject");
}
