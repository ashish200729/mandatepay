import {
  AGENT_ERROR_CLASSES,
  AGENT_TOOL_NAMES,
  AdminResourceIdSchema,
  WORKER_HEARTBEAT_STALE_MS,
  assertOperationalRecord,
  safeEventType,
  safeModelId,
  type AdminAgentMetricsQuery,
  type AdminAgentRun,
  type AdminAgentRunQuery,
  type WorkerRunCounts,
} from "@mandatepay/shared";
import { randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import type { DatabaseClient } from "../client.js";
import { DatabaseError } from "../errors.js";
import {
  decodeCursor,
  defaultOverviewRange,
  encodeCursor,
  iso,
  queryBinding,
  recoveryWhere,
  timestampPage,
  WEBHOOK_LEASE_MS,
  WEBHOOK_MAX_ATTEMPTS,
} from "./admin-query.js";

const ZERO_COUNTS: WorkerRunCounts = {
  scanned: 0,
  claimed: 0,
  processed: 0,
  ignored: 0,
  pending: 0,
  exhausted: 0,
};

type ToolWrite = {
  name: (typeof AGENT_TOOL_NAMES)[number];
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  outcome: "SUCCEEDED" | "FAILED";
  errorClass: (typeof AGENT_ERROR_CLASSES)[number];
};

export type AgentRunWrite = {
  requestId: string;
  userId: string;
  modelId: string;
  startedAt: Date;
  completedAt: Date;
  outcome: "SUCCEEDED" | "FAILED";
  errorClass: (typeof AGENT_ERROR_CLASSES)[number];
  proposalId: string | null;
  refundDraftId: string | null;
  tools: readonly ToolWrite[];
};

function durationMs(startedAt: Date, completedAt: Date) {
  return Math.min(600_000, Math.max(0, completedAt.getTime() - startedAt.getTime()));
}

function countsOf(value: WorkerRunCounts): WorkerRunCounts {
  for (const count of Object.values(value)) {
    if (!Number.isSafeInteger(count) || count < 0 || count > 100_000) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "Worker counts are out of range.");
    }
  }
  return value;
}

export type ObservabilityClient = DatabaseClient | Prisma.TransactionClient;

export class ObservabilityRepository {
  constructor(
    private readonly db: ObservabilityClient,
    private readonly cursorSecret?: string,
  ) {}

  private secret() {
    if (!this.cursorSecret || this.cursorSecret.length < 32) {
      throw new DatabaseError("INVALID_STATE", "Cursor configuration is unavailable.");
    }
    return this.cursorSecret;
  }

  async beginWorkerRun(input: { runId: string; at: Date }) {
    if (!zUuid(input.runId)) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "Worker run ID is invalid.");
    }
    await this.db.workerHeartbeat.create({
      data: {
        worker: "paypal-webhook-recovery",
        runId: input.runId,
        startedAt: input.at,
        heartbeatAt: input.at,
        outcome: "RUNNING",
        ...ZERO_COUNTS,
      },
    });
  }

  async finishWorkerRun(input: {
    runId: string;
    at: Date;
    outcome: "SUCCEEDED" | "FAILED" | "SKIPPED";
    counts: WorkerRunCounts;
  }) {
    const counts = countsOf(input.counts);
    const updated = await this.db.workerHeartbeat.updateMany({
      where: { runId: input.runId, worker: "paypal-webhook-recovery" },
      data: {
        heartbeatAt: input.at,
        completedAt: input.at,
        outcome: input.outcome,
        errorCode: input.outcome === "FAILED" ? "WORKER_FAILED" : null,
        ...counts,
      },
    });
    if (updated.count !== 1) {
      throw new DatabaseError("INVALID_STATE", "Worker heartbeat could not be completed.");
    }
  }

  async recordWebhookDelivery(input: {
    requestId: string;
    receivedAt?: Date;
    eventType: string | null;
    outcome: "REJECTED" | "ACCEPTED" | "DUPLICATE";
    inboxId: string | null;
  }) {
    const requestId = /^[A-Za-z0-9_-]{8,64}$/u.test(input.requestId)
      ? input.requestId
      : randomUUID();
    const record = {
      requestId,
      provider: "paypal",
      eventType: safeEventType(input.eventType),
      outcome: input.outcome,
      inboxId:
        input.inboxId && AdminResourceIdSchema.safeParse(input.inboxId).success
          ? input.inboxId
          : null,
    };
    assertOperationalRecord(record);
    await this.db.webhookDeliveryMetric.create({
      data: { ...record, ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}) },
    });
  }

  async recordAgentRun(input: AgentRunWrite) {
    assertOperationalRecord(input);
    const modelId = safeModelId(input.modelId);
    const proposalId =
      input.proposalId && AdminResourceIdSchema.safeParse(input.proposalId).success
        ? input.proposalId
        : null;
    const refundDraftId =
      input.refundDraftId && AdminResourceIdSchema.safeParse(input.refundDraftId).success
        ? input.refundDraftId
        : null;
    const tools = input.tools.slice(0, 40).map((tool) => ({
      name: tool.name,
      startedAt: tool.startedAt.toISOString(),
      completedAt: tool.completedAt?.toISOString() ?? null,
      durationMs: tool.durationMs,
      outcome: tool.outcome,
      errorClass: tool.errorClass,
    }));
    const record = {
      requestId: input.requestId,
      userId: input.userId,
      modelId,
      outcome: input.outcome,
      errorClass: input.errorClass,
      proposalId,
      refundDraftId,
      tools,
    };
    assertOperationalRecord(record);
    if (!AdminResourceIdSchema.safeParse(input.userId).success) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "Agent run owner is invalid.");
    }
    if (!/^[A-Za-z0-9_-]{8,64}$/u.test(input.requestId)) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "Agent request ID is invalid.");
    }
    await this.db.agentRunMetric.create({
      data: {
        requestId: input.requestId,
        userId: input.userId,
        modelId,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        durationMs: durationMs(input.startedAt, input.completedAt),
        outcome: input.outcome,
        errorClass: input.errorClass,
        proposalId,
        refundDraftId,
        tools: {
          create: input.tools.slice(0, 40).map((tool) => ({
            name: tool.name,
            startedAt: tool.startedAt,
            completedAt: tool.completedAt,
            durationMs:
              tool.durationMs ??
              (tool.completedAt ? durationMs(tool.startedAt, tool.completedAt) : null),
            outcome: tool.outcome,
            errorClass: tool.errorClass,
          })),
        },
      },
    });
  }

  async latestWorker(now = new Date()) {
    return this.db.workerHeartbeat
      .findFirst({
        where: { worker: "paypal-webhook-recovery" },
        orderBy: [{ heartbeatAt: "desc" }, { id: "desc" }],
        select: {
          runId: true,
          startedAt: true,
          heartbeatAt: true,
          completedAt: true,
          outcome: true,
          errorCode: true,
          scanned: true,
          claimed: true,
          processed: true,
          ignored: true,
          pending: true,
          exhausted: true,
        },
      })
      .then((row) => ({ row, staleBefore: new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS) }));
  }

  async webhookOperations(asOf = new Date()) {
    const verified = { provider: "paypal", signatureVerified: true };
    const [backlog, failed, retrying, exhausted, staleLeases, lastProcessed, rejected, duplicate] =
      await Promise.all([
        this.db.webhookInbox.count({ where: recoveryWhere(asOf) }),
        this.db.webhookInbox.count({ where: { ...verified, status: "FAILED" } }),
        this.db.webhookInbox.count({
          where: {
            ...verified,
            status: "FAILED",
            attempts: { lt: WEBHOOK_MAX_ATTEMPTS },
            nextAttemptAt: { gt: asOf },
          },
        }),
        this.db.webhookInbox.count({
          where: { ...verified, status: "FAILED", attempts: { gte: WEBHOOK_MAX_ATTEMPTS } },
        }),
        this.db.webhookInbox.count({
          where: {
            ...verified,
            status: "PROCESSING",
            updatedAt: { lte: new Date(asOf.getTime() - WEBHOOK_LEASE_MS) },
          },
        }),
        this.db.webhookInbox.aggregate({
          where: { status: "PROCESSED", processedAt: { not: null } },
          _max: { processedAt: true },
        }),
        this.db.webhookDeliveryMetric.count({ where: { outcome: "REJECTED" } }),
        this.db.webhookDeliveryMetric.count({ where: { outcome: "DUPLICATE" } }),
      ]);
    return {
      backlog,
      failed,
      retrying,
      exhausted,
      staleLeases,
      lastProcessedAt: lastProcessed._max.processedAt,
      rejected,
      duplicate,
    };
  }

  async latestAgentRun() {
    return this.db.agentRunMetric.findFirst({
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: { outcome: true, completedAt: true, errorClass: true },
    });
  }

  async lastSuccessfulReconcile() {
    const row = await this.db.adminAuditEvent.findFirst({
      where: {
        result: "SUCCESS",
        action: { in: ["ADMIN_PAYMENT_RECONCILE_REQUESTED", "ADMIN_WEBHOOK_RECONCILE_REQUESTED"] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  async platformControlRows() {
    return this.db.platformSetting.findMany({ select: { key: true, valueJson: true } });
  }

  async pingDatabase() {
    const started = Date.now();
    await this.db.$queryRawUnsafe("SELECT 1");
    return Math.min(120_000, Math.max(0, Date.now() - started));
  }

  async listAgentRuns(query: AdminAgentRunQuery): Promise<{
    data: AdminAgentRun[];
    page: { nextCursor: string | null; limit: number };
  }> {
    const { cursor, ...filters } = query;
    const binding = queryBinding({ ...filters, resource: "agent-runs" });
    const boundary = cursor ? decodeCursor(this.secret(), cursor, binding) : undefined;
    const rows = await this.db.agentRunMetric.findMany({
      where: {
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.modelId ? { modelId: query.modelId } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(query.errorClass ? { errorClass: query.errorClass } : {}),
        ...(query.from && query.to
          ? { startedAt: { gte: new Date(query.from), lt: new Date(query.to) } }
          : {}),
        ...timestampPage("startedAt", "desc", boundary),
      },
      include: { tools: { orderBy: [{ startedAt: "asc" }, { id: "asc" }], take: 40 } },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(presentRun),
      page: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor(this.secret(), {
                at: iso(last.startedAt),
                id: last.id,
                binding,
              })
            : null,
      },
    };
  }

  async getAgentRun(id: string): Promise<AdminAgentRun | null> {
    if (!zUuid(id)) return null;
    const row = await this.db.agentRunMetric.findUnique({
      where: { id },
      include: { tools: { orderBy: [{ startedAt: "asc" }, { id: "asc" }], take: 40 } },
    });
    return row ? presentRun(row) : null;
  }

  async agentMetrics(query: AdminAgentMetricsQuery, asOf = new Date()) {
    const range =
      query.from && query.to
        ? { from: new Date(query.from), to: new Date(query.to) }
        : defaultOverviewRange(asOf);
    const inRange = { gte: range.from, lt: range.to };
    const [requests, successfulRuns, failedRuns, latency, toolErrors, refundDrafts, classes] =
      await Promise.all([
        this.db.agentRunMetric.count({ where: { startedAt: inRange } }),
        this.db.agentRunMetric.count({ where: { startedAt: inRange, outcome: "SUCCEEDED" } }),
        this.db.agentRunMetric.count({ where: { startedAt: inRange, outcome: "FAILED" } }),
        this.db.agentRunMetric.aggregate({
          where: { startedAt: inRange, durationMs: { not: null } },
          _avg: { durationMs: true },
        }),
        this.db.agentToolMetric.count({
          where: { startedAt: inRange, outcome: "FAILED" },
        }),
        this.db.agentRunMetric.count({
          where: { startedAt: inRange, refundDraftId: { not: null } },
        }),
        this.db.agentRunMetric.groupBy({
          by: ["errorClass"],
          where: { startedAt: inRange, outcome: "FAILED" },
          _count: true,
        }),
      ]);
    const average = latency._avg.durationMs;
    return {
      asOf: iso(asOf),
      range: { from: iso(range.from), to: iso(range.to) },
      requests,
      successfulRuns,
      failedRuns,
      latencyMs: average === null ? null : Math.round(average),
      toolErrors,
      refundDrafts,
      errorClasses: classes.map((row) => ({ key: row.errorClass, value: row._count })),
    };
  }

  async overviewTelemetry(from: Date, to: Date, asOf: Date) {
    const inRange = { gte: from, lt: to };
    const [
      requests,
      successfulRuns,
      failedRuns,
      latency,
      toolErrors,
      refundDrafts,
      worker,
      rejected,
      duplicate,
      reconcile,
    ] = await Promise.all([
      this.db.agentRunMetric.count({ where: { startedAt: inRange } }),
      this.db.agentRunMetric.count({ where: { startedAt: inRange, outcome: "SUCCEEDED" } }),
      this.db.agentRunMetric.count({ where: { startedAt: inRange, outcome: "FAILED" } }),
      this.db.agentRunMetric.aggregate({
        where: { startedAt: inRange, durationMs: { not: null } },
        _avg: { durationMs: true },
      }),
      this.db.agentToolMetric.count({ where: { startedAt: inRange, outcome: "FAILED" } }),
      this.db.agentRunMetric.count({
        where: { startedAt: inRange, refundDraftId: { not: null } },
      }),
      this.latestWorker(asOf),
      this.db.webhookDeliveryMetric.count({
        where: { outcome: "REJECTED", receivedAt: inRange },
      }),
      this.db.webhookDeliveryMetric.count({
        where: { outcome: "DUPLICATE", receivedAt: inRange },
      }),
      this.lastSuccessfulReconcile(),
    ]);
    return {
      requests,
      successfulRuns,
      failedRuns,
      latencyMs: latency._avg.durationMs === null ? null : Math.round(latency._avg.durationMs),
      toolErrors,
      refundDrafts,
      worker,
      rejected,
      duplicate,
      reconcile,
    };
  }
}

function zUuid(value: string) {
  return zUuidPattern.test(value);
}
const zUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type RunRow = Prisma.AgentRunMetricGetPayload<{
  include: { tools: true };
}>;

function presentRun(row: RunRow): AdminAgentRun {
  return {
    id: row.id,
    requestId: row.requestId,
    userId: row.userId,
    modelId: row.modelId,
    startedAt: iso(row.startedAt),
    completedAt: row.completedAt ? iso(row.completedAt) : null,
    durationMs: row.durationMs,
    outcome: row.outcome,
    errorClass: row.errorClass,
    proposalId: row.proposalId,
    refundDraftId: row.refundDraftId,
    tools: row.tools.map((tool) => ({
      name: tool.name as (typeof AGENT_TOOL_NAMES)[number],
      startedAt: iso(tool.startedAt),
      completedAt: tool.completedAt ? iso(tool.completedAt) : null,
      durationMs: tool.durationMs,
      outcome: tool.outcome,
      errorClass: tool.errorClass,
    })),
  };
}
