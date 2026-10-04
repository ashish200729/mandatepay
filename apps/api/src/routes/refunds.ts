import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DatabaseError, type DatabaseClient } from "@mandatepay/database";
import {
  refundPayment,
  reconcileRefundStatus,
  RefundServiceError,
  type RefundGateway,
} from "../services/refunds.js";

type AuthenticatedUser = { id: string };

export interface RefundRouteContext {
  readonly database: DatabaseClient;
  readonly paypal: RefundGateway | null;
  readonly requireUser: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<AuthenticatedUser | null | undefined>;
  readonly isTrustedOrigin: (origin: string | undefined) => boolean;
}

const refundBodySchema = z
  .object({
    amountMinor: z.number().int().safe().positive().nullable(),
    reason: z.string().trim().min(1).max(255),
    requestKey: z.string().trim().min(1).max(255),
    confirmed: z.literal(true),
  })
  .strict();

const idSchema = z.object({ id: z.string().trim().min(1).max(255) });

function originOf(request: FastifyRequest) {
  const origin = request.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

function error(reply: FastifyReply, cause: unknown) {
  if (cause instanceof RefundServiceError) {
    if (cause.code === "REFUND_POLICY_BLOCKED") {
      return reply.status(cause.httpStatus).send({
        error: "Refund request is not permitted.",
        code: cause.code,
        reasonCodes: cause.reasonCodes,
      });
    }
    return reply.status(cause.httpStatus).send({
      error:
        cause.code === "PAYPAL_UNAVAILABLE"
          ? "PayPal Sandbox is not configured."
          : "Refund provider confirmation is pending.",
      code: cause.code,
    });
  }
  if (cause instanceof DatabaseError) {
    if (cause.code === "NOT_FOUND") return reply.status(404).send({ error: "Payment not found." });
    if (cause.code === "OWNERSHIP_REQUIRED" || cause.code === "CONFLICT") {
      return reply.status(409).send({ error: "Refund request is stale or conflicted." });
    }
    if (cause.code === "INVALID_STATE" || cause.code === "REFUND_EXCEEDS_REMAINING") {
      return reply.status(409).send({ error: "Payment cannot be refunded in its current state." });
    }
    if (cause.code === "INVALID_CURRENCY" || cause.code === "INVALID_DOMAIN_INPUT") {
      return reply.status(400).send({ error: "Refund request is invalid." });
    }
  }
  return reply.status(503).send({ error: "Refund service is temporarily unavailable." });
}

export function registerRefundRoutes(app: FastifyInstance, context: RefundRouteContext) {
  app.post("/api/payments/:id/refund-status", async (request, reply) => {
    if (!context.isTrustedOrigin(originOf(request)))
      return reply.status(403).send({ error: "Request origin is not trusted." });
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const params = idSchema.safeParse(request.params);
    if (
      !params.success ||
      !z
        .object({})
        .strict()
        .safeParse(request.body ?? {}).success
    )
      return reply.status(400).send({ error: "Status check request is invalid." });
    try {
      const result = await reconcileRefundStatus(
        { database: context.database, paypal: context.paypal },
        user,
        params.data.id,
      );
      return reply.status(result.pending ? 202 : 200).send(result);
    } catch (cause) {
      return error(reply, cause);
    }
  });
  app.post("/api/payments/:id/refund", async (request, reply) => {
    if (!context.isTrustedOrigin(originOf(request))) {
      return reply.status(403).send({ error: "Request origin is not trusted." });
    }
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const params = idSchema.safeParse(request.params);
    const body = refundBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: "Refund request is invalid." });
    }
    try {
      const result = await refundPayment(
        { database: context.database, paypal: context.paypal },
        user,
        { paymentId: params.data.id, ...body.data },
      );
      return reply.status(result.pending ? 202 : 200).send({
        refund: result.refund,
        payment: result.payment,
        pending: result.pending,
      });
    } catch (cause) {
      return error(reply, cause);
    }
  });
}

export const registerPaymentRefundRoutes = registerRefundRoutes;
