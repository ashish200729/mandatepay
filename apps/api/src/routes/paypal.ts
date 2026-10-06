import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DatabaseError, type DatabaseClient } from "@mandatepay/database";
import {
  capturePaypalOrder,
  createPaypalOrder,
  getPayment,
  listPayments,
  reconcilePaypalOrder,
  payPalStatusFromEnvironment,
  PaymentServiceError,
  type DemoProductFacts,
  type PayPalGateway,
} from "../services/payments.js";
import { PlatformControlDenied } from "../services/platform-controls.js";

type AuthenticatedUser = { id: string };

export interface PayPalRouteContext {
  readonly database: DatabaseClient;
  readonly appUrl: string;
  readonly paypal: PayPalGateway | null;
  readonly lookupDemoProduct: (externalId: string) => Promise<DemoProductFacts | null>;
  readonly paypalStatus?: {
    readonly configured: boolean;
    readonly environment: "sandbox";
    readonly webhookConfigured: boolean;
  };
  readonly requireUser: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<AuthenticatedUser | null | undefined>;
  readonly isTrustedOrigin: (origin: string | undefined) => boolean;
}

export type PaymentRouteContext = PayPalRouteContext;

const proposalBodySchema = z.object({ proposalId: z.string().trim().min(1).max(255) }).strict();
const emptyBodySchema = z.object({}).strict();
const idSchema = z.object({ id: z.string().trim().min(1).max(255) });

function originOf(request: FastifyRequest) {
  const origin = request.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

function error(reply: FastifyReply, cause: unknown) {
  if (cause instanceof PlatformControlDenied) {
    return reply.status(cause.httpStatus).send({ error: cause.message, code: cause.code });
  }
  if (cause instanceof PaymentServiceError) {
    return reply.status(cause.httpStatus).send({
      error:
        cause.code === "PAYER_APPROVAL_REQUIRED"
          ? "This payment requires approval before PayPal can be called."
          : cause.code === "PAYPAL_UNAVAILABLE"
            ? "PayPal Sandbox is not configured."
            : "PayPal returned an unusable payment response.",
      code: cause.code,
    });
  }
  if (cause instanceof DatabaseError) {
    if (cause.code === "NOT_FOUND") return reply.status(404).send({ error: "Payment not found." });
    if (cause.code === "CONFLICT") return reply.status(409).send({ error: "Payment is stale." });
    if (cause.code === "INVALID_STATE" || cause.code === "LIMIT_EXCEEDED") {
      return reply.status(409).send({ error: "Payment cannot be processed in its current state." });
    }
    if (cause.code === "INVALID_CURRENCY" || cause.code === "INVALID_DOMAIN_INPUT") {
      return reply.status(400).send({ error: "Payment request is invalid." });
    }
  }
  return reply.status(503).send({ error: "Payment service is temporarily unavailable." });
}

function paymentId(request: FastifyRequest) {
  const parsed = idSchema.safeParse(request.params);
  return parsed.success ? parsed.data.id : null;
}

export function registerPayPalRoutes(app: FastifyInstance, context: PayPalRouteContext) {
  const serviceContext = {
    database: context.database,
    paypal: context.paypal,
    appUrl: context.appUrl,
    lookupDemoProduct: context.lookupDemoProduct,
  };

  app.get("/api/paypal/status", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const status = context.paypalStatus ?? {
      configured: context.paypal !== null,
      environment: "sandbox" as const,
      webhookConfigured: false,
    };
    return reply.send(status);
  });

  app.post("/api/paypal/orders", async (request, reply) => {
    if (!context.isTrustedOrigin(originOf(request))) {
      return reply.status(403).send({ error: "Request origin is not trusted." });
    }
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const parsed = proposalBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Payment request is invalid." });
    try {
      const result = await createPaypalOrder(serviceContext, user, parsed.data.proposalId);
      return reply.status(result.pending ? 202 : 200).send({
        payment: result.payment,
        approvalUrl: result.approvalUrl,
      });
    } catch (cause) {
      return error(reply, cause);
    }
  });

  app.post("/api/paypal/orders/:id/capture", async (request, reply) => {
    if (!context.isTrustedOrigin(originOf(request))) {
      return reply.status(403).send({ error: "Request origin is not trusted." });
    }
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const id = paymentId(request);
    if (!id || !emptyBodySchema.safeParse(request.body ?? {}).success) {
      return reply.status(400).send({ error: "Capture request is invalid." });
    }
    try {
      const result = await capturePaypalOrder(serviceContext, user, id);
      return reply.status(result.pending ? 202 : 200).send({ payment: result.payment });
    } catch (cause) {
      return error(reply, cause);
    }
  });

  app.get("/api/orders", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    try {
      return reply.send(await listPayments(serviceContext, user));
    } catch (cause) {
      return error(reply, cause);
    }
  });

  app.post("/api/paypal/orders/:id/reconcile", async (request, reply) => {
    if (!context.isTrustedOrigin(originOf(request)))
      return reply.status(403).send({ error: "Request origin is not trusted." });
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const id = paymentId(request);
    if (!id || !emptyBodySchema.safeParse(request.body ?? {}).success)
      return reply.status(400).send({ error: "Status check request is invalid." });
    try {
      const result = await reconcilePaypalOrder(serviceContext, user, id);
      return reply.status(result.pending ? 202 : 200).send(result);
    } catch (cause) {
      return error(reply, cause);
    }
  });

  app.get("/api/orders/:id", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const id = paymentId(request);
    if (!id) return reply.status(400).send({ error: "Payment id is invalid." });
    try {
      return reply.send(await getPayment(serviceContext, user, id));
    } catch (cause) {
      return error(reply, cause);
    }
  });
}

export const registerPaymentRoutes = registerPayPalRoutes;
export const registerPaypalRoutes = registerPayPalRoutes;

export { payPalStatusFromEnvironment };
