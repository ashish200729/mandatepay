import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DatabaseError, PolicyDecisionType, type DatabaseClient } from "@mandatepay/database";
import {
  dashboardPolicyEvents,
  dashboardSummary,
  dashboardTransactions,
  decodeDashboardCursor,
  listAuditEvents,
  type DashboardFilters,
  type DashboardQueryParserInput,
} from "../services/analytics.js";

type AuthenticatedUser = { id: string };

export interface AnalyticsRouteContext {
  readonly database: DatabaseClient;
  readonly requireUser: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<AuthenticatedUser | null | undefined>;
  readonly isTrustedOrigin?: (origin: string | undefined) => boolean;
  readonly parseQuery?: (input: DashboardQueryParserInput) => Promise<unknown>;
}

const decisionSchema = z.enum([
  PolicyDecisionType.ALLOW,
  PolicyDecisionType.REQUIRE_APPROVAL,
  PolicyDecisionType.BLOCK,
]);
const statusSchema = z.enum([
  "DRAFT",
  "PROPOSED",
  "POLICY_CHECKED",
  "BLOCKED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "AUTHORIZED",
  "PAYPAL_ORDER_CREATED",
  "PAYMENT_PENDING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "CREATED",
  "CAPTURE_PENDING",
  "DENIED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);
const utcDateSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "Date must be UTC.");

const filtersSchema = z
  .object({
    minAmountMinor: z.coerce.number().int().nonnegative().safe().optional(),
    maxAmountMinor: z.coerce.number().int().nonnegative().safe().optional(),
    decision: decisionSchema.optional(),
    category: z.string().trim().min(1).max(120).optional(),
    status: statusSchema.optional(),
    since: utcDateSchema.optional(),
    until: utcDateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.minAmountMinor !== undefined &&
      value.maxAmountMinor !== undefined &&
      value.minAmountMinor > value.maxAmountMinor
    ) {
      context.addIssue({
        code: "custom",
        path: ["maxAmountMinor"],
        message: "Maximum is below minimum.",
      });
    }
    if (value.since && value.until && Date.parse(value.since) > Date.parse(value.until)) {
      context.addIssue({ code: "custom", path: ["until"], message: "Until must follow since." });
    }
    if (value.cursor && !decodeDashboardCursor(value.cursor)) {
      context.addIssue({ code: "custom", path: ["cursor"], message: "Cursor is invalid." });
    }
  });

const auditQuerySchema = z
  .object({ entityId: z.string().trim().min(1).max(255).optional() })
  .strict();
const queryBodySchema = z.object({ query: z.string().trim().min(1).max(1_000) }).strict();

const naturalLanguageFiltersSchema = z
  .object({
    minimumAmountMinor: z.number().int().nonnegative().safe().nullable(),
    minimumAmountOperator: z.enum(["gt", "gte"]).nullable(),
    maximumAmountMinor: z.number().int().nonnegative().safe().nullable(),
    maximumAmountOperator: z.enum(["lt", "lte"]).nullable(),
    decision: decisionSchema.nullable(),
    since: utcDateSchema.nullable(),
    until: utcDateSchema.nullable(),
    category: z.string().trim().min(1).max(120).nullable(),
    chart: z.enum(["table", "category", "decisions"]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.minimumAmountMinor === null) !== (value.minimumAmountOperator === null)) {
      context.addIssue({
        code: "custom",
        path: ["minimumAmountOperator"],
        message: "Minimum amount and operator must be paired.",
      });
    }
    if ((value.maximumAmountMinor === null) !== (value.maximumAmountOperator === null)) {
      context.addIssue({
        code: "custom",
        path: ["maximumAmountOperator"],
        message: "Maximum amount and operator must be paired.",
      });
    }
    if (value.minimumAmountMinor !== null && value.maximumAmountMinor !== null) {
      const min = value.minimumAmountMinor;
      const max = value.maximumAmountMinor;
      if (
        min > max ||
        (min === max &&
          (value.minimumAmountOperator === "gt" || value.maximumAmountOperator === "lt"))
      ) {
        context.addIssue({
          code: "custom",
          path: ["maximumAmountMinor"],
          message: "Maximum is below minimum.",
        });
      }
    }
    if (value.since && value.until && Date.parse(value.since) > Date.parse(value.until)) {
      context.addIssue({ code: "custom", path: ["until"], message: "Until must follow since." });
    }
  });

const naturalLanguageResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("needs_clarification"),
      clarification: z.string().trim().min(1).max(1_000),
      filters: z.null(),
    })
    .strict(),
  z.object({ status: z.literal("ready"), filters: naturalLanguageFiltersSchema }).strict(),
]);

function filtersFromParsed(value: z.output<typeof filtersSchema>): DashboardFilters {
  return {
    minAmountMinor: value.minAmountMinor,
    maxAmountMinor: value.maxAmountMinor,
    minAmountExclusive: false,
    maxAmountExclusive: false,
    decision: value.decision,
    category: value.category,
    status: value.status,
    since: value.since ? new Date(value.since) : undefined,
    until: value.until ? new Date(value.until) : undefined,
    limit: value.limit,
    cursor: value.cursor ? (decodeDashboardCursor(value.cursor) ?? undefined) : undefined,
  };
}

function error(reply: FastifyReply, cause: unknown) {
  if (cause instanceof DatabaseError) {
    if (cause.code === "NOT_FOUND")
      return reply.status(404).send({ error: "Analytics record not found." });
    if (cause.code === "INVALID_DOMAIN_INPUT" || cause.code === "INVALID_MONEY") {
      return reply.status(400).send({ error: "Analytics request is invalid." });
    }
  }
  return reply.status(503).send({ error: "Analytics service is temporarily unavailable." });
}

function originOf(request: FastifyRequest) {
  const value = request.headers.origin;
  return Array.isArray(value) ? value[0] : value;
}

async function authenticated(
  context: AnalyticsRouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  return context.requireUser(request, reply);
}

export function registerAnalyticsRoutes(app: FastifyInstance, context: AnalyticsRouteContext) {
  const queryRate = new Map<string, { count: number; resetAt: number }>();

  app.get("/api/audit", async (request, reply) => {
    const user = await authenticated(context, request, reply);
    if (!user) return;
    const parsed = auditQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "Audit query is invalid." });
    try {
      return reply.send(await listAuditEvents(context.database, user, parsed.data.entityId));
    } catch (cause) {
      return error(reply, cause);
    }
  });

  app.get("/api/dashboard/summary", async (request, reply) => {
    const user = await authenticated(context, request, reply);
    if (!user) return;
    try {
      return reply.send(await dashboardSummary(context.database, user));
    } catch (cause) {
      return error(reply, cause);
    }
  });

  app.get("/api/dashboard/transactions", async (request, reply) => {
    const user = await authenticated(context, request, reply);
    if (!user) return;
    const parsed = filtersSchema.safeParse(request.query);
    if (!parsed.success)
      return reply.status(400).send({ error: "Transaction filters are invalid." });
    try {
      return reply.send(
        await dashboardTransactions(context.database, user, filtersFromParsed(parsed.data)),
      );
    } catch (cause) {
      return error(reply, cause);
    }
  });

  app.get("/api/dashboard/policy-events", async (request, reply) => {
    const user = await authenticated(context, request, reply);
    if (!user) return;
    try {
      return reply.send(await dashboardPolicyEvents(context.database, user));
    } catch (cause) {
      return error(reply, cause);
    }
  });

  app.post("/api/dashboard/query", async (request, reply) => {
    if (context.isTrustedOrigin && !context.isTrustedOrigin(originOf(request))) {
      return reply.status(403).send({ error: "Request origin is not trusted." });
    }
    const user = await authenticated(context, request, reply);
    if (!user) return;
    const now = Date.now();
    for (const [key, entry] of queryRate) {
      if (entry.resetAt <= now) queryRate.delete(key);
    }
    const current = queryRate.get(user.id);
    if (!current && queryRate.size >= 2_048) {
      return reply.status(429).send({ error: "Dashboard query service is busy." });
    }
    if (!current || current.resetAt <= now) {
      queryRate.set(user.id, { count: 1, resetAt: now + 60_000 });
    } else {
      if (current.count >= 5) {
        reply.header("retry-after", Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
        return reply.status(429).send({ error: "Too many dashboard queries. Try again shortly." });
      }
      current.count += 1;
    }
    const body = queryBodySchema.safeParse(request.body);
    if (!body.success || !context.parseQuery) {
      return reply.status(400).send({ error: "Dashboard query is invalid." });
    }
    try {
      const parsed = await context.parseQuery({
        query: body.data.query,
        now: new Date().toISOString(),
      });
      const natural = naturalLanguageResultSchema.safeParse(parsed);
      if (!natural.success)
        return reply.status(400).send({ error: "Dashboard query filters are invalid." });
      if (natural.data.status === "needs_clarification") return reply.send(natural.data);
      const filters = natural.data.filters;
      const transactions = await dashboardTransactions(context.database, user, {
        minAmountMinor: filters.minimumAmountMinor ?? undefined,
        maxAmountMinor: filters.maximumAmountMinor ?? undefined,
        minAmountExclusive: filters.minimumAmountOperator === "gt",
        maxAmountExclusive: filters.maximumAmountOperator === "lt",
        decision: filters.decision ?? undefined,
        category: filters.category ?? undefined,
        since: filters.since ? new Date(filters.since) : undefined,
        until: filters.until ? new Date(filters.until) : undefined,
        limit: 100,
      });
      return reply.send({ ...natural.data, ...transactions });
    } catch (cause) {
      return error(reply, cause);
    }
  });
}
