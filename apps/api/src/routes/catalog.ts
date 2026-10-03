import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  Channel3Client,
  lookupDemoProduct,
  searchDemoCatalog,
  type NormalizedProduct,
} from "@mandatepay/channel3";
import {
  DatabaseError,
  MandateRepository,
  proposalFingerprint,
  type DatabaseClient,
} from "@mandatepay/database";
import {
  CanonicalMandateSchema,
  calculatePurchaseTotal,
  multiplyMinorUnits,
  toMinorUnits,
} from "@mandatepay/shared";
import { serializeProposal } from "../services/proposals.js";

type Owner = { id: string };
type ProductRef = { source: "demo" | "channel3"; externalId: string };
export interface CatalogRouteContext {
  database: DatabaseClient;
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<Owner | null | undefined>;
  isTrustedOrigin: (origin: string | undefined) => boolean;
  mode: "demo" | "channel3";
  channel3?: Channel3Client;
  rank: (mandate: unknown, products: readonly NormalizedProduct[]) => Promise<unknown>;
}
const id = z.string().trim().min(1).max(255);
const refSchema = z.object({ source: z.enum(["demo", "channel3"]), externalId: id }).strict();
const searchSchema = z
  .object({ mandateId: id, query: z.string().trim().min(1).max(500).optional() })
  .strict();
const compareSchema = z
  .object({ mandateId: id, products: z.array(refSchema).min(1).max(3) })
  .strict();
const proposalSchema = z
  .object({
    mandateId: id,
    source: z.enum(["demo", "channel3"]),
    productId: id,
    quantity: z.number().int().min(1).max(1000),
    requestKey: id,
  })
  .strict();
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function fail(reply: FastifyReply, cause: unknown) {
  if (cause instanceof DatabaseError) {
    const status =
      cause.code === "NOT_FOUND"
        ? 404
        : cause.code === "CONFLICT" || cause.code === "INVALID_STATE"
          ? 409
          : 400;
    return reply.status(status).send({
      error:
        status === 404 ? "Mandate or product not found." : "Purchase request is invalid or stale.",
      code: cause.code,
    });
  }
  return reply.status(503).send({
    error: "Product service is temporarily unavailable.",
    code: "PRODUCT_SERVICE_UNAVAILABLE",
  });
}
async function ownedMandate(context: CatalogRouteContext, mandateId: string, userId: string) {
  const mandate = await new MandateRepository(context.database).getByIdForUser(mandateId, userId);
  if (
    mandate.status !== "ACTIVE" ||
    !mandate.activeVersion ||
    new Date() >= mandate.expiresAt ||
    new Date() < mandate.startsAt
  ) {
    throw new DatabaseError("INVALID_STATE", "A currently active mandate is required.");
  }
  return { mandate, rules: CanonicalMandateSchema.parse(mandate.activeVersion.canonicalRules) };
}
async function lookup(context: CatalogRouteContext, product: ProductRef) {
  if (product.source === "demo") {
    const found = lookupDemoProduct(product.externalId);
    if (!found) throw new DatabaseError("NOT_FOUND", "Product not found.");
    return found;
  }
  if (context.mode !== "channel3" || !context.channel3)
    throw new DatabaseError("INVALID_STATE", "Live discovery is unavailable.");
  const found = await context.channel3.lookupProduct({ productId: product.externalId });
  if (!found || found.source !== "channel3")
    throw new DatabaseError("NOT_FOUND", "External product no longer available.");
  return found;
}

/** No client amount, merchant, snapshot ID, policy decision or owner is accepted. */
export function registerCatalogRoutes(app: FastifyInstance, context: CatalogRouteContext) {
  const rateLimits = new Map<string, { count: number; resetAt: number }>();
  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    if (!context.isTrustedOrigin(request.headers.origin)) {
      reply
        .status(403)
        .send({ error: "Request origin is not trusted.", code: "ORIGIN_NOT_TRUSTED" });
      return null;
    }
    const user = await context.requireUser(request, reply);
    if (!user) return null;
    const now = Date.now();
    for (const [key, entry] of rateLimits) if (entry.resetAt <= now) rateLimits.delete(key);
    const key = `${user.id}:${request.routeOptions.url}`;
    const limit = request.routeOptions.url === "/api/products/compare" ? 5 : 30;
    const current = rateLimits.get(key);
    if (current && current.resetAt > now) {
      if (current.count >= limit) {
        reply.header("retry-after", Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
        reply
          .status(429)
          .send({ error: "Too many product requests. Try again shortly.", code: "RATE_LIMITED" });
        return null;
      }
      current.count += 1;
    } else {
      if (rateLimits.size >= 4096) {
        reply
          .status(429)
          .send({ error: "Product service is busy. Try again shortly.", code: "RATE_LIMITED" });
        return null;
      }
      rateLimits.set(key, { count: 1, resetAt: now + 60_000 });
    }
    return user;
  }
  app.post("/api/products/search", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const parsed = searchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid product search." });
    try {
      const { rules } = await ownedMandate(context, parsed.data.mandateId, user.id);
      const query = parsed.data.query ?? rules.productIntent;
      const products =
        context.mode === "demo"
          ? searchDemoCatalog(query)
          : await context.channel3!.searchProducts({ query, limit: 20 });
      const mode =
        products.some((product) => product.source === "demo") || context.mode === "demo"
          ? "demo"
          : "channel3";
      await context.database.auditEvent.create({
        data: {
          userId: user.id,
          eventType: "PRODUCT_SEARCH_COMPLETED",
          entityType: "MANDATE",
          entityId: parsed.data.mandateId,
          payload: {
            queryHash: hash(query),
            mode,
            productIds: products.map((product) => product.externalId),
          },
        },
      });
      return reply.send({
        products,
        mode,
        notice:
          mode === "demo"
            ? "Demo Catalog — illustrative products from our sandbox merchant. No payment has been made."
            : "Channel3 discovery — external retailer products are not eligible for demo checkout.",
      });
    } catch (cause) {
      return fail(reply, cause);
    }
  });
  app.post("/api/products/compare", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const parsed = compareSchema.safeParse(request.body);
    if (
      !parsed.success ||
      new Set(parsed.data.products.map((item) => `${item.source}:${item.externalId}`)).size !==
        parsed.data.products.length
    ) {
      return reply.status(400).send({ error: "Select one to three distinct products." });
    }
    try {
      const { rules } = await ownedMandate(context, parsed.data.mandateId, user.id);
      const products = await Promise.all(
        parsed.data.products.map((product) => lookup(context, product)),
      );
      if (new Set(products.map((product) => product.externalId)).size !== products.length)
        throw new DatabaseError("CONFLICT", "Product identities overlap.");
      return reply.send({ ranking: await context.rank(rules, products) });
    } catch (cause) {
      return fail(reply, cause);
    }
  });
  app.post("/api/proposals", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const parsed = proposalSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .status(400)
        .send({ error: "Invalid purchase proposal. Amounts are calculated by the server." });
    if (parsed.data.source !== "demo")
      return reply
        .status(409)
        .send({ error: "External discovery products are not eligible for demo checkout." });
    try {
      const product = await lookup(context, {
        source: parsed.data.source,
        externalId: parsed.data.productId,
      });
      if (!product.checkoutEligible || !product.demoSku)
        throw new DatabaseError("INVALID_STATE", "Product is not purchasable.");
      const subtotal = multiplyMinorUnits(product.priceMinor, parsed.data.quantity);
      // Our controlled demo merchant has explicit zero shipping/tax. No external price assumptions.
      const shipping = toMinorUnits(0);
      const tax = toMinorUnits(0);
      const total = calculatePurchaseTotal({ subtotal, shipping, tax });
      const snapshotIdentity = hash(product);
      const requestKey = `proposal_${hash([user.id, parsed.data.requestKey])}`;
      const stored = await context.database.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', user.id);
        await tx.$queryRawUnsafe(
          'SELECT id FROM "Mandate" WHERE id = $1 FOR UPDATE',
          parsed.data.mandateId,
        );
        const mandate = await tx.mandate.findFirst({
          where: { id: parsed.data.mandateId, userId: user.id },
          include: { activeVersion: true },
        });
        if (!mandate) throw new DatabaseError("NOT_FOUND", "Mandate not found.");
        const now = new Date();
        if (
          mandate.status !== "ACTIVE" ||
          !mandate.activeVersionId ||
          !mandate.activeVersion ||
          now < mandate.startsAt ||
          now >= mandate.expiresAt
        )
          throw new DatabaseError("INVALID_STATE", "Mandate is not active.");
        CanonicalMandateSchema.parse(mandate.activeVersion.canonicalRules);
        const snapshot = await tx.productSnapshot.upsert({
          where: { source_externalId: { source: product.source, externalId: snapshotIdentity } },
          update: {},
          create: {
            source: product.source,
            externalId: snapshotIdentity,
            title: product.title,
            brand: product.brand,
            category: product.category,
            condition: product.condition,
            price: BigInt(product.priceMinor),
            currency: product.currency,
            merchant: product.merchant,
            metadata: {
              externalId: product.externalId,
              demoSku: product.demoSku,
              checkoutEligible: true,
            },
            capturedAt: now,
          },
        });
        const fingerprint = proposalFingerprint({
          userId: user.id,
          mandateId: mandate.id,
          mandateVersionId: mandate.activeVersionId,
          productSnapshotId: snapshot.id,
          quantity: parsed.data.quantity,
          subtotal: BigInt(subtotal),
          shipping: BigInt(shipping),
          tax: BigInt(tax),
          total: BigInt(total),
          currency: product.currency,
        });
        const existing = await tx.purchaseProposal.findUnique({
          where: { idempotencyKey: requestKey },
        });
        if (existing) {
          if (existing.userId !== user.id || existing.proposalFingerprint !== fingerprint)
            throw new DatabaseError("CONFLICT", "Request key changed.");
          return existing;
        }
        const proposal = await tx.purchaseProposal.create({
          data: {
            userId: user.id,
            mandateId: mandate.id,
            mandateVersionId: mandate.activeVersionId,
            productSnapshotId: snapshot.id,
            quantity: parsed.data.quantity,
            subtotal: BigInt(subtotal),
            shipping: 0n,
            tax: 0n,
            total: BigInt(total),
            currency: product.currency,
            status: "PROPOSED",
            proposalFingerprint: fingerprint,
            idempotencyKey: requestKey,
            expiresAt: new Date(Math.min(now.getTime() + 900_000, mandate.expiresAt.getTime())),
          },
        });
        await tx.auditEvent.create({
          data: {
            userId: user.id,
            eventType: "PURCHASE_PROPOSAL_CREATED",
            entityType: "PURCHASE_PROPOSAL",
            entityId: proposal.id,
            payload: {
              mandateId: mandate.id,
              version: mandate.version,
              productSnapshotId: snapshot.id,
              total,
              currency: product.currency,
              source: product.source,
            },
          },
        });
        return proposal;
      });
      return reply.status(201).send({ proposal: serializeProposal(stored) });
    } catch (cause) {
      return fail(reply, cause);
    }
  });
}
