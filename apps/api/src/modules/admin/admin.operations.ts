import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AdminOperationsRepository,
  AdminAuditRepository,
  isDatabaseError,
} from "@mandatepay/database";
import {
  ADMIN_EXPORT_COLUMNS,
  AdminActivityQuerySchema,
  AdminApprovalQuerySchema,
  AdminDomainAuditQuerySchema,
  AdminMandateQuerySchema,
  AdminMandateVersionQuerySchema,
  AdminOrderQuerySchema,
  AdminOverviewQuerySchema,
  AdminPaymentQuerySchema,
  AdminProposalDecisionQuerySchema,
  AdminProposalQuerySchema,
  AdminRefundQuerySchema,
  AdminResourceIdSchema,
  AdminUserQuerySchema,
  AdminUserSessionQuerySchema,
  AdminWebhookQuerySchema,
  AdminAuditQuerySchema,
  buildAdminCsv,
  type AdminExportResource,
} from "@mandatepay/shared";
import { createMutationRateLimiter } from "../../services/rate-limits.js";

const idParam = z.object({ id: AdminResourceIdSchema }).strict();

export function registerAdminOperationRoutes(
  scope: FastifyInstance,
  options: {
    getDatabase: () => ConstructorParameters<typeof AdminOperationsRepository>[0];
    getSecret: () => string;
    discoveryMode?: string;
    sendError: (
      reply: FastifyReply,
      request: FastifyRequest,
      code: string,
      status: number,
      message: string,
    ) => unknown;
    trace: (request: FastifyRequest) => { requestId: string; correlationId: string };
  },
) {
  const operations = () =>
    new AdminOperationsRepository(options.getDatabase(), options.getSecret());
  const exports = createMutationRateLimiter({ maximum: 2 });
  const invalid = (reply: FastifyReply, request: FastifyRequest, message = "Invalid filters.") =>
    options.sendError(reply, request, "ADMIN_INVALID_REQUEST", 400, message);
  function queryError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
    if (isDatabaseError(error) && error.code === "INVALID_DOMAIN_INPUT")
      return invalid(reply, request, "Invalid filters or cursor.");
    if (
      isDatabaseError(error) &&
      (error.code === "INVALID_MONEY" || error.code === "INVALID_CURRENCY")
    )
      return options.sendError(
        reply,
        request,
        "ADMIN_UNAVAILABLE",
        503,
        "Administration is temporarily unavailable.",
      );
    throw error;
  }
  async function listed<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    schema: z.ZodType<T>,
    run: (query: T) => Promise<object>,
  ) {
    const parsed = schema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, request);
    try {
      return { ...(await run(parsed.data)), ...options.trace(request) };
    } catch (error) {
      return queryError(reply, request, error);
    }
  }
  async function detail(
    request: FastifyRequest,
    reply: FastifyReply,
    load: (id: string) => Promise<unknown>,
    missing: string,
  ) {
    const parsed = idParam.safeParse(request.params);
    if (!parsed.success) return invalid(reply, request, "Invalid record ID.");
    try {
      const data = await load(parsed.data.id);
      if (!data) return options.sendError(reply, request, "ADMIN_TARGET_NOT_FOUND", 404, missing);
      return { data, ...options.trace(request) };
    } catch (error) {
      return queryError(reply, request, error);
    }
  }
  async function csv<Q extends { limit?: number; cursor?: string }>(
    request: FastifyRequest,
    reply: FastifyReply,
    resource: AdminExportResource,
    schema: z.ZodType<Q>,
    load: (query: Q) => Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }>,
    flatten: (row: Record<string, unknown>) => Record<string, string | number | boolean | null>,
  ) {
    const principal = request.id;
    const identity = (request as FastifyRequest & { adminPrincipalId?: string }).adminPrincipalId;
    const rate = exports(identity ?? principal);
    if (!rate.allowed) {
      reply.header("retry-after", rate.retryAfter);
      return options.sendError(
        reply,
        request,
        "ADMIN_RATE_LIMITED",
        429,
        "Too many requests. Try again shortly.",
      );
    }
    const parsed = schema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, request);
    try {
      const result = await load(parsed.data);
      const columns = ADMIN_EXPORT_COLUMNS[resource];
      const body = buildAdminCsv(
        columns,
        result.rows.map((row) => flatten(row)),
        result.truncated,
      );
      reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${resource}.csv"`)
        .header("x-export-truncated", result.truncated ? "true" : "false")
        .header("x-export-row-count", String(result.rows.length));
      return reply.send(body);
    } catch (error) {
      return queryError(reply, request, error);
    }
  }

  scope.get("/overview", (request, reply) =>
    listed(request, reply, AdminOverviewQuerySchema, (query) =>
      operations()
        .overview(query, { discoveryMode: options.discoveryMode })
        .then((data) => ({ data })),
    ),
  );
  scope.get("/overview/activity", (request, reply) =>
    listed(request, reply, AdminActivityQuerySchema, (query) => operations().listActivity(query)),
  );
  scope.get("/users", (request, reply) =>
    listed(request, reply, AdminUserQuerySchema, (query) => operations().listUsers(query)),
  );
  scope.get("/users/export", (request, reply) =>
    csv(
      request,
      reply,
      "users",
      AdminUserQuerySchema,
      (query) => operations().exportUsers(query),
      flattenUser,
    ),
  );
  scope.get("/users/:id", (request, reply) =>
    detail(request, reply, (id) => operations().getUser(id), "User not found."),
  );
  scope.get("/users/:id/sessions", (request, reply) => {
    const id = idParam.safeParse(request.params);
    if (!id.success) return invalid(reply, request, "Invalid record ID.");
    return listed(request, reply, AdminUserSessionQuerySchema, (query) =>
      operations().listUserSessions(id.data.id, query),
    );
  });
  scope.get("/mandates", (request, reply) =>
    listed(request, reply, AdminMandateQuerySchema, (query) => operations().listMandates(query)),
  );
  scope.get("/mandates/export", (request, reply) =>
    csv(
      request,
      reply,
      "mandates",
      AdminMandateQuerySchema,
      (query) => operations().exportMandates(query),
      flattenMandate,
    ),
  );
  scope.get("/mandates/:id", (request, reply) =>
    detail(request, reply, (id) => operations().getMandate(id), "Mandate not found."),
  );
  scope.get("/mandates/:id/versions", (request, reply) => {
    const id = idParam.safeParse(request.params);
    if (!id.success) return invalid(reply, request, "Invalid record ID.");
    return listed(request, reply, AdminMandateVersionQuerySchema, (query) =>
      operations().listMandateVersions(id.data.id, query),
    );
  });
  scope.get("/proposals", (request, reply) =>
    listed(request, reply, AdminProposalQuerySchema, (query) => operations().listProposals(query)),
  );
  scope.get("/proposals/export", (request, reply) =>
    csv(
      request,
      reply,
      "proposals",
      AdminProposalQuerySchema,
      (query) => operations().exportProposals(query),
      flattenProposal,
    ),
  );
  scope.get("/proposals/:id", (request, reply) =>
    detail(request, reply, (id) => operations().getProposal(id), "Proposal not found."),
  );
  scope.get("/proposals/:id/decisions", (request, reply) => {
    const id = idParam.safeParse(request.params);
    if (!id.success) return invalid(reply, request, "Invalid record ID.");
    return listed(request, reply, AdminProposalDecisionQuerySchema, (query) =>
      operations().listProposalDecisions(id.data.id, query),
    );
  });
  scope.get("/proposals/:id/reservation", async (request, reply) => {
    const parsed = idParam.safeParse(request.params);
    if (!parsed.success) return invalid(reply, request, "Invalid record ID.");
    try {
      const proposal = await operations().getProposal(parsed.data.id);
      if (!proposal)
        return options.sendError(
          reply,
          request,
          "ADMIN_TARGET_NOT_FOUND",
          404,
          "Proposal not found.",
        );
      return {
        data: await operations().getProposalReservation(parsed.data.id),
        ...options.trace(request),
      };
    } catch (error) {
      return queryError(reply, request, error);
    }
  });
  scope.get("/approvals", (request, reply) =>
    listed(request, reply, AdminApprovalQuerySchema, (query) => operations().listApprovals(query)),
  );
  scope.get("/approvals/export", (request, reply) =>
    csv(
      request,
      reply,
      "approvals",
      AdminApprovalQuerySchema,
      (query) => operations().exportApprovals(query),
      flattenApproval,
    ),
  );
  scope.get("/approvals/:id", (request, reply) =>
    detail(request, reply, (id) => operations().getApproval(id), "Approval not found."),
  );
  scope.get("/orders", (request, reply) =>
    listed(request, reply, AdminOrderQuerySchema, (query) => operations().listOrders(query)),
  );
  scope.get("/orders/export", (request, reply) =>
    csv(
      request,
      reply,
      "orders",
      AdminOrderQuerySchema,
      (query) => operations().exportOrders(query),
      flattenOrder,
    ),
  );
  scope.get("/orders/:id", (request, reply) =>
    detail(request, reply, (id) => operations().getOrder(id), "Order not found."),
  );
  scope.get("/payments", (request, reply) =>
    listed(request, reply, AdminPaymentQuerySchema, (query) => operations().listPayments(query)),
  );
  scope.get("/payments/export", (request, reply) =>
    csv(
      request,
      reply,
      "payments",
      AdminPaymentQuerySchema,
      (query) => operations().exportPayments(query),
      flattenPayment,
    ),
  );
  scope.get("/payments/:id", (request, reply) =>
    detail(request, reply, (id) => operations().getPayment(id), "Payment not found."),
  );
  scope.get("/refunds", (request, reply) =>
    listed(request, reply, AdminRefundQuerySchema, (query) => operations().listRefunds(query)),
  );
  scope.get("/refunds/export", (request, reply) =>
    csv(
      request,
      reply,
      "refunds",
      AdminRefundQuerySchema,
      (query) => operations().exportRefunds(query),
      flattenRefund,
    ),
  );
  scope.get("/refunds/:id", (request, reply) =>
    detail(request, reply, (id) => operations().getRefund(id), "Refund not found."),
  );
  scope.get("/webhooks", (request, reply) =>
    listed(request, reply, AdminWebhookQuerySchema, (query) => operations().listWebhooks(query)),
  );
  scope.get("/webhooks/export", (request, reply) =>
    csv(
      request,
      reply,
      "webhooks",
      AdminWebhookQuerySchema,
      (query) => operations().exportWebhooks(query),
      flattenWebhook,
    ),
  );
  scope.get("/webhooks/:id", (request, reply) =>
    detail(request, reply, (id) => operations().getWebhook(id), "Webhook event not found."),
  );
  scope.get("/domain-audit", (request, reply) =>
    listed(request, reply, AdminDomainAuditQuerySchema, (query) =>
      operations().listDomainAudit(query),
    ),
  );
  scope.get("/domain-audit/:id", (request, reply) =>
    detail(request, reply, (id) => operations().getDomainAudit(id), "Audit event not found."),
  );
  scope.get("/audit/export", (request, reply) =>
    csv(
      request,
      reply,
      "audit",
      AdminAuditQuerySchema,
      async (query) => {
        const rows: Array<Record<string, unknown>> = [];
        let cursor: string | undefined;
        while (rows.length < 1000) {
          const remaining = 1000 - rows.length;
          const listedAudit = await new AdminAuditRepository(
            options.getDatabase(),
            options.getSecret(),
          ).list({
            ...query,
            limit: remaining < 100 ? remaining : 100,
            cursor,
          });
          rows.push(...listedAudit.data);
          if (!listedAudit.page.nextCursor || listedAudit.data.length === 0)
            return { rows, truncated: false };
          cursor = listedAudit.page.nextCursor;
          if (rows.length >= 1000) return { rows, truncated: true };
        }
        return { rows, truncated: Boolean(cursor) };
      },
      flattenAudit,
    ),
  );
}

function ownerFields(row: Record<string, unknown>) {
  const owner = row.owner as { id?: string; email?: string; name?: string } | undefined;
  return {
    ownerId: owner?.id ?? null,
    ownerEmail: owner?.email ?? null,
    ownerName: owner?.name ?? null,
  };
}
function flattenUser(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: (row.name as string | null) ?? null,
    email: String(row.email),
    emailVerified: Boolean(row.emailVerified),
    autonomousPurchasingEnabled: Boolean(row.autonomousPurchasingEnabled),
    activeMandateCount: Number(row.activeMandateCount),
    proposalCount: Number(row.proposalCount),
    capturedGrossMinor: Number(row.capturedGrossMinor),
    lastActivityAt: String(row.lastActivityAt),
    createdAt: String(row.createdAt),
  };
}
function flattenMandate(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    ...ownerFields(row),
    title: String(row.title),
    status: String(row.status),
    version: Number(row.version),
    transactionLimitMinor: Number(row.transactionLimitMinor),
    effectiveExpired: Boolean(row.effectiveExpired),
    startsAt: String(row.startsAt),
    expiresAt: String(row.expiresAt),
    createdAt: String(row.createdAt),
  };
}
function flattenProposal(row: Record<string, unknown>) {
  const decision = row.latestDecision as { decision?: string } | null;
  return {
    id: String(row.id),
    ...ownerFields(row),
    mandateId: String(row.mandateId),
    status: String(row.status),
    decision: decision?.decision ?? null,
    totalMinor: Number(row.totalMinor),
    currency: "USD",
    isSample: Boolean(row.isSample),
    createdAt: String(row.createdAt),
  };
}
function flattenApproval(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    ...ownerFields(row),
    proposalId: String(row.proposalId),
    decision: String(row.decision),
    effectiveExpired: Boolean(row.effectiveExpired),
    expiresAt: String(row.expiresAt),
    decidedAt: (row.decidedAt as string | null) ?? null,
    createdAt: String(row.createdAt),
  };
}
function flattenOrder(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    ...ownerFields(row),
    proposalId: String(row.proposalId),
    paypalOrderId: (row.paypalOrderId as string | null) ?? null,
    amountMinor: Number(row.amountMinor),
    paymentStatus: String(row.paymentStatus),
    reconciliation: String(row.reconciliation),
    createdAt: String(row.createdAt),
  };
}
function flattenPayment(row: Record<string, unknown>) {
  return {
    ...flattenOrder(row),
    mandateId: String(row.mandateId),
    paypalCaptureId: (row.paypalCaptureId as string | null) ?? null,
    refundState: String(row.refundState),
    capturedAt: (row.capturedAt as string | null) ?? null,
  };
}
function flattenRefund(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    ...ownerFields(row),
    paymentId: String(row.paymentId),
    amountMinor: Number(row.amountMinor),
    kind: String(row.kind),
    status: String(row.status),
    paypalRefundId: (row.paypalRefundId as string | null) ?? null,
    settledAt: (row.settledAt as string | null) ?? null,
    createdAt: String(row.createdAt),
  };
}
function flattenWebhook(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    providerEventId: String(row.providerEventId),
    eventType: String(row.eventType),
    signatureVerified: Boolean(row.signatureVerified),
    status: String(row.status),
    attempts: Number(row.attempts),
    stale: Boolean(row.stale),
    retryEligible: Boolean(row.retryEligible),
    exhausted: Boolean(row.exhausted),
    errorCode: (row.errorCode as string | null) ?? null,
    receivedAt: String(row.receivedAt),
    processedAt: (row.processedAt as string | null) ?? null,
  };
}
function flattenAudit(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    action: String(row.action),
    targetType: String(row.targetType),
    targetId: String(row.targetId),
    result: String(row.result),
    actorUserId: (row.actorUserId as string | null) ?? null,
    createdAt: String(row.createdAt),
  };
}
