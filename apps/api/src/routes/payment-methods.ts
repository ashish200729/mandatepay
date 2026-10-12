import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DatabaseError, type DatabaseClient } from "@mandatepay/database";
import {
  VAULT_CONSENT_VERSION,
  PaymentMethodError,
  cancelVaultSetup,
  completeVaultSetup,
  getPaymentMethod,
  removeVaultMethod,
  startVaultSetup,
  type PaymentMethodContext,
  type VaultGateway,
} from "../services/payment-methods.js";
import {
  PaymentServiceError,
  autopayPreview,
  autopayProposal,
  type DemoProductFacts,
  type PayPalGateway,
  type PaymentServiceContext,
} from "../services/payments.js";
import { PlatformControlDenied } from "../services/platform-controls.js";
import { getProposal } from "../services/proposals.js";
import { createMutationRateLimiter } from "../services/rate-limits.js";
import type { VaultCipher } from "../services/vault-crypto.js";

type AuthenticatedUser = { id: string };

export interface PaymentMethodRouteContext {
  readonly database: DatabaseClient;
  readonly appUrl: string;
  readonly paypal: (PayPalGateway & VaultGateway) | null;
  /** Null when TOKEN_ENCRYPTION_KEY is missing or invalid: saving PayPal is refused. */
  readonly vault: VaultCipher | null;
  readonly lookupDemoProduct: (externalId: string) => Promise<DemoProductFacts | null>;
  readonly requireUser: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<AuthenticatedUser | null | undefined>;
  readonly isTrustedOrigin: (origin: string | undefined) => boolean;
}

const emptyBodySchema = z.object({}).strict();
const consentBodySchema = z
  .object({ consent: z.literal(true), consentVersion: z.literal(VAULT_CONSENT_VERSION) })
  .strict();
const idSchema = z.object({ id: z.string().trim().min(1).max(255) });

function originOf(request: FastifyRequest) {
  const origin = request.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

const methodMessages: Record<PaymentMethodError["code"], string> = {
  VAULT_UNAVAILABLE: "Saving PayPal for autonomous purchases is not available on this server.",
  SETUP_NOT_FOUND:
    "There is no PayPal approval waiting to be completed. Start again from Settings.",
  SETUP_EXPIRED: "The PayPal approval expired. Start again from Settings.",
  SETUP_NOT_APPROVED: "PayPal did not confirm your approval. Nothing was saved; start again.",
  REMOVAL_PENDING: "Your saved PayPal is still being removed. Try again shortly.",
  PAYPAL_OUTCOME_UNKNOWN: "PayPal has not confirmed this change yet. Refresh Settings to check.",
  PAYPAL_RESPONSE_INVALID: "PayPal returned a response MandatePay could not use. Try again.",
  PAYPAL_REQUEST_REJECTED: "PayPal declined this request. Nothing was saved.",
};

function sendError(reply: FastifyReply, cause: unknown) {
  if (cause instanceof PaymentMethodError) {
    return reply
      .status(cause.httpStatus)
      .send({ error: methodMessages[cause.code], code: cause.code });
  }
  if (cause instanceof PlatformControlDenied) {
    return reply.status(cause.httpStatus).send({ error: cause.message, code: cause.code });
  }
  if (cause instanceof PaymentServiceError) {
    return reply.status(cause.httpStatus).send({
      error:
        cause.code === "PAYPAL_UNAVAILABLE"
          ? "PayPal is not configured."
          : cause.code === "CART_MANDATE_MISMATCH"
            ? "This cart no longer matches the cart mandate signed when it was authorized, so PayPal was not called."
            : "PayPal returned an unusable payment response.",
      code: cause.code,
    });
  }
  if (cause instanceof DatabaseError) {
    if (cause.code === "NOT_FOUND") return reply.status(404).send({ error: "Proposal not found." });
    if (cause.code === "CONFLICT") return reply.status(409).send({ error: "Proposal is stale." });
    if (cause.code === "INVALID_STATE" || cause.code === "LIMIT_EXCEEDED") {
      return reply
        .status(409)
        .send({ error: "This purchase cannot be paid in its current state." });
    }
    if (cause.code === "INVALID_CURRENCY" || cause.code === "INVALID_DOMAIN_INPUT") {
      return reply.status(400).send({ error: "Payment request is invalid." });
    }
  }
  return reply.status(503).send({ error: "Payment service is temporarily unavailable." });
}

/**
 * Saved PayPal (Vault) consent, removal and buyer-not-present payment for
 * AgentGuard ALLOW proposals. The PayPal payment token id never leaves the server.
 */
export function registerPaymentMethodRoutes(
  app: FastifyInstance,
  context: PaymentMethodRouteContext,
) {
  const methodContext: PaymentMethodContext = {
    database: context.database,
    paypal: context.paypal,
    appUrl: context.appUrl,
    vault: context.vault,
  };
  const paymentContext: PaymentServiceContext = {
    database: context.database,
    paypal: context.paypal,
    appUrl: context.appUrl,
    lookupDemoProduct: context.lookupDemoProduct,
    vault: context.vault,
  };
  // Consent changes start PayPal requests, so they get their own small per-user bucket.
  const consumeMethodChange = createMutationRateLimiter({ maximum: 10 });

  async function mutationUser(request: FastifyRequest, reply: FastifyReply) {
    if (!context.isTrustedOrigin(originOf(request))) {
      await reply.status(403).send({ error: "Request origin is not trusted." });
      return null;
    }
    const user = await context.requireUser(request, reply);
    if (!user) return null;
    const rate = consumeMethodChange(user.id);
    if (!rate.allowed) {
      await reply
        .header("retry-after", rate.retryAfter)
        .status(429)
        .send({ error: "Too many payment method changes. Try again shortly." });
      return null;
    }
    return user;
  }

  app.get("/api/payment-methods/paypal", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    try {
      return reply.send({ paymentMethod: await getPaymentMethod(methodContext, user) });
    } catch (cause) {
      return sendError(reply, cause);
    }
  });

  app.post("/api/payment-methods/paypal/setup", async (request, reply) => {
    const user = await mutationUser(request, reply);
    if (!user) return;
    if (!consentBodySchema.safeParse(request.body).success) {
      return reply.status(400).send({
        error: "Confirm the current consent text before saving PayPal.",
        code: "CONSENT_REQUIRED",
      });
    }
    try {
      return reply.send(await startVaultSetup(methodContext, user));
    } catch (cause) {
      return sendError(reply, cause);
    }
  });

  for (const [path, action] of [
    ["complete", completeVaultSetup],
    ["cancel", cancelVaultSetup],
    ["remove", removeVaultMethod],
  ] as const) {
    app.post(`/api/payment-methods/paypal/${path}`, async (request, reply) => {
      const user = await mutationUser(request, reply);
      if (!user) return;
      if (!emptyBodySchema.safeParse(request.body ?? {}).success) {
        return reply.status(400).send({ error: "Payment method request is invalid." });
      }
      try {
        const result = await action(methodContext, user);
        const pending = result.paymentMethod.status === "REMOVAL_PENDING";
        return reply.status(pending ? 202 : 200).send(result);
      } catch (cause) {
        return sendError(reply, cause);
      }
    });
  }

  app.get("/api/proposals/:id/autopay", async (request, reply) => {
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "Proposal id is invalid." });
    try {
      return reply.send({ autopay: await autopayPreview(paymentContext, user, params.data.id) });
    } catch (cause) {
      return sendError(reply, cause);
    }
  });

  app.post("/api/proposals/:id/autopay", async (request, reply) => {
    if (!context.isTrustedOrigin(originOf(request))) {
      return reply.status(403).send({ error: "Request origin is not trusted." });
    }
    // requireUser applies the shared financial-mutation rate limit to /api/proposals/*.
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success || !emptyBodySchema.safeParse(request.body ?? {}).success) {
      return reply.status(400).send({ error: "Autopay request is invalid." });
    }
    try {
      const autopay = await autopayProposal(paymentContext, user, params.data.id);
      const current = await getProposal(context.database, user, params.data.id);
      return reply
        .status(autopay.outcome === "PENDING" ? 202 : 200)
        .send({ autopay, proposal: current.proposal, decision: current.decision });
    } catch (cause) {
      return sendError(reply, cause);
    }
  });
}
