import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DatabaseError,
  MandateRepository,
  PaymentStatus,
  Prisma,
  type DatabaseClient,
} from "@mandatepay/database";
import { parseDecimalToMinorUnits } from "@mandatepay/shared";
import {
  FindTransactionToolInputSchema,
  PrepareRefundRequestToolInputSchema,
  ShoppingAgentError,
  ShoppingAgentToolSchemas,
  type ShoppingAgentResult,
  type ShoppingAgentToolHandlers,
} from "@mandatepay/agent";
import {
  paymentReceiptInclude,
  serializePayment,
  type PaymentReceipt,
} from "../services/payments.js";

type AuthenticatedUser = { id: string };

export interface ShoppingAgentRouteContext {
  readonly app: FastifyInstance;
  readonly database: DatabaseClient;
  readonly appUrl: string;
  readonly requireUser: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<AuthenticatedUser | null | undefined>;
  readonly isTrustedOrigin: (origin: string | undefined) => boolean;
  readonly runner: (
    input: { message: string; now: string },
    tools: ShoppingAgentToolHandlers,
  ) => Promise<ShoppingAgentResult>;
  readonly modelId?: string;
}

const chatBodySchema = z
  .object({
    message: z.string().trim().min(1).max(1_000),
    mandateId: z.string().trim().min(1).max(255).optional(),
    requestKey: z.string().trim().min(1).max(255),
  })
  .strict();

const activeStatuses: PaymentStatus[] = [PaymentStatus.COMPLETED, PaymentStatus.PARTIALLY_REFUNDED];
const rateWindowMs = 60_000;
const rateLimit = 5;

type SafeProduct = {
  readonly source: "demo" | "channel3";
  readonly externalId: string;
  readonly title: string;
  readonly brand: string | null;
  readonly category: string | null;
  readonly condition: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly merchant: string;
};

function originOf(request: FastifyRequest) {
  const value = request.headers.origin;
  return Array.isArray(value) ? value[0] : value;
}

function cookieOf(request: FastifyRequest): string | undefined {
  const value = request.headers.cookie;
  return Array.isArray(value) ? value[0] : value;
}

function safeError(reply: FastifyReply, cause: unknown) {
  if (cause instanceof ShoppingAgentError) {
    const status = cause.code === "TOOL_UNAVAILABLE" ? 503 : 400;
    return reply.status(status).send({ error: "Shopping agent could not complete this request." });
  }
  if (cause instanceof DatabaseError) {
    if (cause.code === "NOT_FOUND")
      return reply.status(404).send({ error: "Shopping record not found." });
    if (cause.code === "CONFLICT" || cause.code === "INVALID_STATE") {
      return reply.status(409).send({ error: "Shopping request is stale or unavailable." });
    }
    return reply.status(400).send({ error: "Shopping request is invalid." });
  }
  return reply.status(503).send({ error: "Shopping agent is temporarily unavailable." });
}

function jsonBody(response: { statusCode: number; body: string }): unknown {
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeProduct(value: unknown): SafeProduct | null {
  if (!isRecord(value)) return null;
  const source = value.source === "demo" || value.source === "channel3" ? value.source : null;
  if (
    !source ||
    typeof value.externalId !== "string" ||
    typeof value.title !== "string" ||
    (value.brand !== null && typeof value.brand !== "string") ||
    (value.category !== null && typeof value.category !== "string") ||
    typeof value.condition !== "string" ||
    typeof value.priceMinor !== "number" ||
    !Number.isSafeInteger(value.priceMinor) ||
    typeof value.currency !== "string" ||
    typeof value.merchant !== "string"
  ) {
    return null;
  }
  return {
    source,
    externalId: value.externalId,
    title: value.title,
    brand: value.brand,
    category: value.category,
    condition: value.condition,
    priceMinor: value.priceMinor,
    currency: value.currency,
    merchant: value.merchant,
  };
}

function safePayment(payment: PaymentReceipt) {
  const dto = serializePayment(payment);
  return {
    id: dto.id,
    proposalId: dto.proposalId,
    status: dto.status,
    amount: dto.amount,
    currency: dto.currency,
    capturedAt: dto.capturedAt,
    product: dto.product,
    mandate: dto.mandate,
  };
}

async function internalJSON(
  context: ShoppingAgentRouteContext,
  request: FastifyRequest,
  method: "POST" | "GET",
  url: string,
  payload?: unknown,
) {
  const options: Record<string, unknown> = {
    method,
    url,
    headers: {
      origin: context.appUrl,
      ...(cookieOf(request) ? { cookie: cookieOf(request) } : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
  };
  if (payload !== undefined) options.payload = payload;
  const response = (await context.app.inject(options as never)) as unknown as {
    statusCode: number;
    body: string;
  };
  const body = jsonBody(response);
  if (response.statusCode >= 400)
    throw new DatabaseError("INVALID_STATE", "Internal shopping operation failed.");
  return body;
}

async function activeMandate(
  database: DatabaseClient,
  userId: string,
  mandateId: string | undefined,
) {
  const now = new Date();
  if (mandateId) {
    const mandate = await new MandateRepository(database).getByIdForUser(mandateId, userId);
    if (
      mandate.status !== "ACTIVE" ||
      !mandate.activeVersion ||
      now < mandate.startsAt ||
      now >= mandate.expiresAt
    ) {
      throw new DatabaseError("INVALID_STATE", "Mandate is not currently active.");
    }
    return mandate;
  }
  const mandates = await database.mandate.findMany({
    where: { userId, status: "ACTIVE", startsAt: { lte: now }, expiresAt: { gt: now } },
    include: { activeVersion: true },
    take: 2,
  });
  if (mandates.length !== 1 || !mandates[0]?.activeVersion) return null;
  return mandates[0];
}

function clarification(message: string) {
  return {
    message,
    explanation: null,
    proposals: [],
    refundDraft: null,
    steps: [],
  };
}

export function registerShoppingAgentRoutes(
  app: FastifyInstance,
  context: ShoppingAgentRouteContext,
) {
  const rateLimits = new Map<string, { count: number; resetAt: number }>();

  app.post("/api/agent/chat", async (request, reply) => {
    if (!context.isTrustedOrigin(originOf(request))) {
      return reply.status(403).send({ error: "Request origin is not trusted." });
    }
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const nowMs = Date.now();
    for (const [key, value] of rateLimits) if (value.resetAt <= nowMs) rateLimits.delete(key);
    const currentRate = rateLimits.get(user.id);
    if (!currentRate && rateLimits.size >= 2_048) {
      return reply.status(429).send({ error: "Shopping agent is busy." });
    }
    if (!currentRate || currentRate.resetAt <= nowMs) {
      rateLimits.set(user.id, { count: 1, resetAt: nowMs + rateWindowMs });
    } else if (currentRate.count >= rateLimit) {
      reply.header("retry-after", Math.ceil((currentRate.resetAt - nowMs) / 1000));
      return reply.status(429).send({ error: "Too many shopping requests. Try again shortly." });
    } else {
      currentRate.count += 1;
    }

    const body = chatBodySchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Shopping request is invalid." });
    try {
      const mandate = await activeMandate(context.database, user.id, body.data.mandateId);
      if (!mandate) {
        return reply.send(clarification("Select exactly one active purchase mandate to continue."));
      }
      const mandateId = mandate.id;
      const knownProducts = new Map<string, SafeProduct>();
      const proposals: unknown[] = [];
      let refundDraft: unknown = null;
      const steps: Array<{ name: string; status: "completed" }> = [];

      const tools: ShoppingAgentToolHandlers = {
        get_active_mandates: async () => ({
          mandates: [
            {
              id: mandate.id,
              title: mandate.activeVersion?.title ?? mandate.title,
              version: mandate.activeVersion?.version ?? mandate.version,
              expiresAt: mandate.expiresAt.toISOString(),
            },
          ],
        }),
        search_products: async (input) => {
          const parsed = ShoppingAgentToolSchemas.search_products.parse(input);
          const response = await internalJSON(context, request, "POST", "/api/products/search", {
            mandateId,
            query: parsed.query,
          });
          const products =
            isRecord(response) && Array.isArray(response.products) ? response.products : [];
          const safe = products
            .map(safeProduct)
            .filter((product): product is SafeProduct => product !== null)
            .filter((product) => {
              if (
                parsed.maximumPriceMinor !== null &&
                product.priceMinor > parsed.maximumPriceMinor
              )
                return false;
              if (
                parsed.brands.length &&
                (!product.brand ||
                  !parsed.brands.some(
                    (brand) => brand.toLowerCase() === product.brand?.toLowerCase(),
                  ))
              )
                return false;
              if (
                parsed.category &&
                product.category?.toLowerCase() !== parsed.category.toLowerCase()
              )
                return false;
              return true;
            });
          for (const product of safe) knownProducts.set(product.externalId, product);
          steps.push({ name: "search_products", status: "completed" });
          return { products: safe };
        },
        get_product_details: async (input) => {
          const parsed = ShoppingAgentToolSchemas.get_product_details.parse(input);
          const product = knownProducts.get(parsed.productId);
          if (!product) return { error: "Product must come from a trusted search result." };
          steps.push({ name: "get_product_details", status: "completed" });
          return { product };
        },
        compare_products: async (input) => {
          const parsed = ShoppingAgentToolSchemas.compare_products.parse(input);
          const products = parsed.productIds.map((id) => knownProducts.get(id));
          if (products.some((product) => !product))
            return { error: "Products must come from trusted search results." };
          steps.push({ name: "compare_products", status: "completed" });
          return {
            products: products.filter((product): product is SafeProduct => product !== undefined),
          };
        },
        create_purchase_proposal: async (input) => {
          const parsed = ShoppingAgentToolSchemas.create_purchase_proposal.parse(input);
          const product = knownProducts.get(parsed.productId);
          if (!product || product.source !== parsed.source)
            return { error: "Product must come from a trusted search result." };
          const response = await internalJSON(context, request, "POST", "/api/proposals", {
            mandateId,
            source: parsed.source,
            productId: parsed.productId,
            quantity: parsed.quantity,
            requestKey: body.data.requestKey,
          });
          if (!isRecord(response) || !isRecord(response.proposal))
            return { error: "Proposal could not be prepared." };
          let actual = response;
          const proposalId = typeof response.proposal.id === "string" ? response.proposal.id : null;
          if (!proposalId) return { error: "Proposal could not be prepared." };
          const evaluated = await internalJSON(
            context,
            request,
            "POST",
            `/api/proposals/${encodeURIComponent(proposalId)}/evaluate`,
            {},
          );
          if (isRecord(evaluated) && isRecord(evaluated.proposal)) actual = evaluated;
          else
            actual = (await internalJSON(
              context,
              request,
              "GET",
              `/api/proposals/${encodeURIComponent(proposalId)}`,
            )) as Record<string, unknown>;
          proposals.push(actual);
          await context.database.auditEvent.create({
            data: {
              userId: user.id,
              eventType: "PRODUCT_SELECTED",
              entityType: "PURCHASE_PROPOSAL",
              entityId: proposalId,
              payload: {
                proposalId,
                mandateId,
                source: parsed.source,
                quantity: parsed.quantity,
                aiReason: "model_selected_server_validated_product",
                queryHash: createHash("sha256").update(body.data.message).digest("hex"),
                ...(context.modelId ? { modelId: context.modelId } : {}),
              },
            },
          });
          steps.push({ name: "create_purchase_proposal", status: "completed" });
          return actual;
        },
        find_transaction: async (input) => {
          const parsed = FindTransactionToolInputSchema.parse(input);
          const where: Prisma.PaymentWhereInput = {
            userId: user.id,
            isSample: false,
            status: { in: activeStatuses },
            proposal: { isSample: false },
            ...(parsed.transactionId ? { id: parsed.transactionId } : {}),
          };
          let payments = await context.database.payment.findMany({
            where,
            include: paymentReceiptInclude,
            orderBy: { createdAt: "desc" },
            take: 25,
          });
          if (parsed.query) {
            const query = parsed.query.toLowerCase();
            payments = payments.filter((payment) =>
              [
                payment.proposal.productSnapshot.title,
                payment.proposal.productSnapshot.merchant,
                payment.proposal.productSnapshot.category ?? "",
              ]
                .join(" ")
                .toLowerCase()
                .includes(query),
            );
          }
          steps.push({ name: "find_transaction", status: "completed" });
          return { transactions: payments.map(safePayment) };
        },
        prepare_refund_request: async (input) => {
          const parsed = PrepareRefundRequestToolInputSchema.parse(input);
          const payment = await context.database.payment.findFirst({
            where: {
              id: parsed.paymentID,
              userId: user.id,
              isSample: false,
              status: { in: activeStatuses },
              proposal: { isSample: false },
            },
            include: { refunds: true },
          });
          if (!payment || !payment.paypalCaptureId)
            return { error: "Only an owned captured payment can be refunded." };
          const alreadyRefunded = payment.refunds
            .filter((refund) =>
              ["REQUESTED", "APPROVED", "SUBMITTED", "COMPLETED"].includes(refund.status),
            )
            .reduce((sum, refund) => sum + refund.amount, 0n);
          const remaining = payment.amount - alreadyRefunded;
          const amountMinor =
            parsed.amountDecimal === null ? null : parseDecimalToMinorUnits(parsed.amountDecimal);
          if (
            remaining <= 0n ||
            (amountMinor !== null && (BigInt(amountMinor) <= 0n || BigInt(amountMinor) > remaining))
          ) {
            return { error: "Refund amount exceeds the remaining refundable amount." };
          }
          refundDraft = {
            paymentId: payment.id,
            amountMinor,
            reason: parsed.reason,
            reviewUrl: `/orders/${payment.id}`,
          };
          steps.push({ name: "prepare_refund_request", status: "completed" });
          return refundDraft;
        },
      };
      const result = await context.runner(
        { message: body.data.message, now: new Date().toISOString() },
        tools,
      );
      return reply.send({
        message:
          "Shopping request completed. Review the prepared recommendations and policy decisions.",
        explanation: result.finalAIExplanation,
        proposals,
        refundDraft,
        steps,
      });
    } catch (cause) {
      return safeError(reply, cause);
    }
  });
}
