import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isDatabaseError, ObservabilityRepository } from "@mandatepay/database";
import {
  AdminAgentMetricsQuerySchema,
  AdminAgentMetricsSchema,
  AdminAgentRunQuerySchema,
  AdminAgentRunSchema,
  AdminIntegrationHealthSchema,
  AdminResourceIdSchema,
  AdminSystemHealthSchema,
  AdminWorkerHealthSchema,
} from "@mandatepay/shared";
import { z } from "zod";
import { readSystemHealth, type IntegrationProbe } from "../../services/system-health.js";

const idParam = z.object({ runId: z.uuid() }).strict();

export function registerAdminObservabilityRoutes(
  scope: FastifyInstance,
  options: {
    getDatabase: () => ConstructorParameters<typeof ObservabilityRepository>[0];
    getSecret: () => string;
    environment: string;
    paypalConfigured: boolean;
    channel3Configured: boolean;
    probePaypal?: () => Promise<IntegrationProbe>;
    probeChannel3?: () => Promise<IntegrationProbe>;
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
  const repository = () => new ObservabilityRepository(options.getDatabase(), options.getSecret());
  const invalid = (reply: FastifyReply, request: FastifyRequest) =>
    options.sendError(reply, request, "ADMIN_INVALID_REQUEST", 400, "Invalid filters.");
  function queryError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
    if (isDatabaseError(error) && error.code === "INVALID_DOMAIN_INPUT")
      return invalid(reply, request);
    return options.sendError(
      reply,
      request,
      "ADMIN_UNAVAILABLE",
      503,
      "Administration is temporarily unavailable.",
    );
  }

  async function snapshot(reply: FastifyReply, request: FastifyRequest) {
    try {
      return await readSystemHealth({
        database: options.getDatabase(),
        environment: options.environment,
        paypalConfigured: options.paypalConfigured,
        channel3Configured: options.channel3Configured,
        probePaypal: options.probePaypal,
        probeChannel3: options.probeChannel3,
      });
    } catch {
      await options.sendError(
        reply,
        request,
        "ADMIN_UNAVAILABLE",
        503,
        "System health is temporarily unavailable.",
      );
      return null;
    }
  }

  scope.get("/system/health", async (request, reply) => {
    const result = await snapshot(reply, request);
    if (!result) return;
    const parsed = AdminSystemHealthSchema.safeParse(result.health);
    if (!parsed.success) {
      return options.sendError(
        reply,
        request,
        "ADMIN_UNAVAILABLE",
        503,
        "System health is temporarily unavailable.",
      );
    }
    return { data: parsed.data, ...options.trace(request) };
  });
  scope.get("/system/workers", async (request, reply) => {
    const result = await snapshot(reply, request);
    if (!result) return;
    const parsed = AdminWorkerHealthSchema.safeParse(result.workers);
    if (!parsed.success) {
      return options.sendError(
        reply,
        request,
        "ADMIN_UNAVAILABLE",
        503,
        "Worker health is temporarily unavailable.",
      );
    }
    return { data: parsed.data, ...options.trace(request) };
  });
  scope.get("/system/integrations", async (request, reply) => {
    const result = await snapshot(reply, request);
    if (!result) return;
    const parsed = AdminIntegrationHealthSchema.safeParse(result.integrations);
    if (!parsed.success) {
      return options.sendError(
        reply,
        request,
        "ADMIN_UNAVAILABLE",
        503,
        "Integration health is temporarily unavailable.",
      );
    }
    return { data: parsed.data, ...options.trace(request) };
  });

  scope.get("/agent/metrics", async (request, reply) => {
    const parsed = AdminAgentMetricsQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, request);
    try {
      const metrics = await repository().agentMetrics(parsed.data);
      const data = AdminAgentMetricsSchema.parse({
        asOf: metrics.asOf,
        range: metrics.range,
        requests: countMetric(metrics.requests, "Agent runs started in the selected range."),
        successfulRuns: countMetric(
          metrics.successfulRuns,
          "Agent runs that completed successfully in range.",
        ),
        failedRuns: countMetric(metrics.failedRuns, "Agent runs that failed in range."),
        latencyMs: {
          value: metrics.latencyMs,
          availability: "available",
          reason:
            metrics.latencyMs === null
              ? "No completed runs in range."
              : "Average duration in milliseconds.",
          definition: "Average recorded agent-run duration in the selected range.",
        },
        toolErrors: countMetric(metrics.toolErrors, "Agent tool calls that failed in range."),
        refundDrafts: countMetric(
          metrics.refundDrafts,
          "Agent runs that prepared a refund draft identifier in range.",
        ),
        errorClasses: {
          value: metrics.errorClasses.reduce(
            (sum: number, row: { value: number }) => sum + row.value,
            0,
          ),
          availability: "available",
          reason: null,
          definition: "Failed agent runs grouped by safe error class.",
          series: metrics.errorClasses,
        },
      });
      return { data, ...options.trace(request) };
    } catch (error) {
      return queryError(reply, request, error);
    }
  });

  scope.get("/agent/runs", async (request, reply) => {
    const parsed = AdminAgentRunQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, request);
    try {
      const listed = await repository().listAgentRuns(parsed.data);
      return {
        data: listed.data.map((row: (typeof listed.data)[number]) =>
          AdminAgentRunSchema.parse(row),
        ),
        page: listed.page,
        ...options.trace(request),
      };
    } catch (error) {
      return queryError(reply, request, error);
    }
  });

  scope.get("/agent/runs/:runId", async (request, reply) => {
    const parsed = idParam.safeParse(request.params);
    if (!parsed.success || !AdminResourceIdSchema.safeParse(parsed.data?.runId).success) {
      return options.sendError(reply, request, "ADMIN_INVALID_REQUEST", 400, "Invalid record ID.");
    }
    try {
      const row = await repository().getAgentRun(parsed.data.runId);
      if (!row) {
        return options.sendError(
          reply,
          request,
          "ADMIN_TARGET_NOT_FOUND",
          404,
          "Agent run not found.",
        );
      }
      return { data: AdminAgentRunSchema.parse(row), ...options.trace(request) };
    } catch (error) {
      return queryError(reply, request, error);
    }
  });
}

function countMetric(value: number, definition: string) {
  return { value, availability: "available" as const, reason: null, definition };
}
