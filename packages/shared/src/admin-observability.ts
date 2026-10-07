import { z } from "zod";
import { AdminResourceIdSchema } from "./admin-audit.js";

const utc = z.iso.datetime({ offset: false });

export const HEALTH_STATUSES = ["ready", "degraded", "unavailable", "unknown"] as const;
export const HealthStatusSchema = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const SYSTEM_COMPONENT_IDS = [
  "api",
  "database",
  "worker",
  "webhooks",
  "paypal",
  "channel3",
  "demoCatalog",
  "agent",
] as const;

export const WORKER_HEARTBEAT_STALE_MS = 15 * 60_000;
export const DATABASE_SLOW_MS = 1_000;
export const PROBE_CACHE_MS = 30_000;

export const AGENT_RUN_OUTCOMES = ["SUCCEEDED", "FAILED"] as const;
export const AGENT_ERROR_CLASSES = [
  "NONE",
  "TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "INVALID_RESPONSE",
  "TOOL_FAILURE",
  "RATE_LIMITED",
  "CANCELLED",
  "UNKNOWN",
] as const;
export const AGENT_TOOL_NAMES = [
  "get_active_mandates",
  "search_products",
  "get_product_details",
  "compare_products",
  "create_purchase_proposal",
  "find_transaction",
  "prepare_refund_request",
] as const;
export const WEBHOOK_DELIVERY_OUTCOMES = ["REJECTED", "ACCEPTED", "DUPLICATE"] as const;
export const WORKER_RUN_OUTCOMES = ["RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"] as const;

const sensitiveTelemetry =
  /(?:\b(?:password|passwd|secret|token|authorization|cookie|api[_ -]?key|client[_ -]?secret)\s*[:=]|\bbearer\s+\S+|-----BEGIN|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b(?:sk|pk|re)_[A-Za-z0-9_-]{12,}|https?:\/\/\S*[?@]|\b[A-Za-z0-9_+/=-]{48,}\b)/iu;

const forbiddenTelemetryKey =
  /^(message|messages|prompt|prompts|arguments|args|reasoning|thought|thoughts|transcript|explanation|completion|content|toolarguments|tool_arguments|apikey|api_key|token|secret|authorization|password|chainofthought|chain_of_thought|rawbody|payload)$/iu;

export function assertOperationalRecord(value: unknown, depth = 0): void {
  if (depth > 6) throw new Error("TELEMETRY_TOO_DEEP");
  if (Array.isArray(value)) {
    for (const entry of value) assertOperationalRecord(entry, depth + 1);
    return;
  }
  if (typeof value === "string") {
    if (sensitiveTelemetry.test(value)) throw new Error("TELEMETRY_SENSITIVE");
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenTelemetryKey.test(key)) throw new Error("TELEMETRY_FORBIDDEN_FIELD");
    assertOperationalRecord(entry, depth + 1);
  }
}

export function safeModelId(value: string | null | undefined): string {
  if (value && /^[A-Za-z0-9._:-]{1,64}$/u.test(value) && !sensitiveTelemetry.test(value))
    return value;
  return "unspecified";
}

export function safeRequestId(value: string | null | undefined): string {
  if (value && /^[A-Za-z0-9_-]{8,64}$/u.test(value) && !sensitiveTelemetry.test(value))
    return value;
  return crypto.randomUUID();
}

export function safeEventType(value: string | null | undefined): string | null {
  if (value && /^[A-Z0-9._]{1,64}$/u.test(value)) return value;
  return null;
}

export function safeBuild(input: { commitSha?: string | null; version?: string | null }): {
  commitSha: string | null;
  version: string | null;
} {
  const commit = input.commitSha?.trim() ?? "";
  const version = input.version?.trim() ?? "";
  return {
    commitSha: /^[0-9a-f]{7,40}$/iu.test(commit) ? commit.toLowerCase() : null,
    version: /^[A-Za-z0-9._-]{1,64}$/u.test(version) ? version : null,
  };
}

export function classifyAgentFailure(
  code: string | undefined,
): (typeof AGENT_ERROR_CLASSES)[number] {
  switch (code) {
    case "UPSTREAM_TIMEOUT":
    case "UPSTREAM_ABORTED":
    case "TOOL_TIMEOUT":
    case "SHOPPING_TIMEOUT":
      return "TIMEOUT";
    case "UPSTREAM_UNAVAILABLE":
    case "SHOPPING_AI_UNAVAILABLE":
      return "PROVIDER_UNAVAILABLE";
    case "TOOL_UNAVAILABLE":
    case "TOOL_HANDLER_FAILED":
    case "SHOPPING_TOOLS_UNAVAILABLE":
    case "SHOPPING_OPERATION_REJECTED":
      return "TOOL_FAILURE";
    case "MODEL_RESPONSE_INVALID":
    case "MODEL_REFUSAL":
    case "MODEL_TRUNCATED":
    case "INVALID_TOOL_CALL":
    case "INVALID_TOOL_ARGUMENTS":
    case "UNKNOWN_TOOL":
    case "TOOL_ROUND_LIMIT":
    case "SHOPPING_AI_RESPONSE_INVALID":
    case "INVALID_INPUT":
      return "INVALID_RESPONSE";
    case "RATE_LIMITED":
    case "SHOPPING_RATE_LIMITED":
      return "RATE_LIMITED";
    case "CANCELLED":
    case "ABORTED":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

const rank: Record<HealthStatus, number> = {
  unavailable: 3,
  degraded: 2,
  unknown: 1,
  ready: 0,
};

/** Unconfigured integrations stay visible but do not make the platform unknown. */
export function aggregateHealth(
  components: readonly { status: HealthStatus; configured: boolean | null }[],
): HealthStatus {
  const operating = components.filter((component) => component.configured !== false);
  let worst: HealthStatus = "ready";
  for (const component of operating) {
    if (rank[component.status] > rank[worst]) worst = component.status;
  }
  return worst;
}

export function workerLiveness(input: {
  heartbeatAt: Date | null;
  outcome: (typeof WORKER_RUN_OUTCOMES)[number] | null;
  now: Date;
}): { status: HealthStatus; summary: string } {
  if (!input.heartbeatAt || !input.outcome) {
    return {
      status: "unknown",
      summary: "No webhook worker heartbeat has been recorded. Liveness is unknown.",
    };
  }
  const age = input.now.getTime() - input.heartbeatAt.getTime();
  if (age > WORKER_HEARTBEAT_STALE_MS) {
    return {
      status: "degraded",
      summary: "The last webhook worker heartbeat is older than 15 minutes.",
    };
  }
  if (input.outcome === "FAILED") {
    return { status: "degraded", summary: "The last webhook recovery run failed." };
  }
  if (input.outcome === "SKIPPED") {
    return { status: "degraded", summary: "Webhook processing is turned off." };
  }
  if (input.outcome === "RUNNING") {
    return { status: "ready", summary: "A webhook recovery run is in progress." };
  }
  return { status: "ready", summary: "The last webhook recovery run succeeded." };
}

export const AdminHealthComponentSchema = z
  .object({
    id: z.enum(SYSTEM_COMPONENT_IDS),
    status: HealthStatusSchema,
    configured: z.boolean().nullable(),
    enabled: z.boolean().nullable(),
    summary: z.string().min(1).max(300),
    latencyMs: z.number().int().nonnegative().max(120_000).nullable(),
    lastSuccessAt: utc.nullable(),
    backlog: z.number().int().nonnegative().nullable(),
    failed: z.number().int().nonnegative().nullable(),
    retrying: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type AdminHealthComponent = z.infer<typeof AdminHealthComponentSchema>;

export const AdminBuildSchema = z
  .object({
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/iu)
      .nullable(),
    version: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/u)
      .nullable(),
  })
  .strict();

export const AdminSystemHealthSchema = z
  .object({
    observedAt: utc,
    environment: z.enum(["development", "test", "production", "unknown"]),
    build: AdminBuildSchema,
    overall: HealthStatusSchema,
    components: z.array(AdminHealthComponentSchema).max(8),
  })
  .strict();
export type AdminSystemHealth = z.infer<typeof AdminSystemHealthSchema>;

export const AdminWorkerSnapshotSchema = z
  .object({
    worker: z.literal("paypal-webhook-recovery"),
    status: HealthStatusSchema,
    runId: z.uuid().nullable(),
    startedAt: utc.nullable(),
    heartbeatAt: utc.nullable(),
    completedAt: utc.nullable(),
    outcome: z.enum(WORKER_RUN_OUTCOMES).nullable(),
    errorCode: z.literal("WORKER_FAILED").nullable(),
    counts: z
      .object({
        scanned: z.number().int().nonnegative(),
        claimed: z.number().int().nonnegative(),
        processed: z.number().int().nonnegative(),
        ignored: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
        exhausted: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const AdminWorkerHealthSchema = z
  .object({
    observedAt: utc,
    staleAfterSeconds: z.literal(WORKER_HEARTBEAT_STALE_MS / 1000),
    workers: z.array(AdminWorkerSnapshotSchema).max(4),
  })
  .strict();
export type AdminWorkerHealth = z.infer<typeof AdminWorkerHealthSchema>;

export const AdminIntegrationHealthSchema = z
  .object({
    observedAt: utc,
    note: z.string().min(1).max(300),
    components: z.array(AdminHealthComponentSchema).max(4),
  })
  .strict();
export type AdminIntegrationHealth = z.infer<typeof AdminIntegrationHealthSchema>;

const counts = z
  .object({
    scanned: z.number().int().nonnegative().max(100_000),
    claimed: z.number().int().nonnegative().max(100_000),
    processed: z.number().int().nonnegative().max(100_000),
    ignored: z.number().int().nonnegative().max(100_000),
    pending: z.number().int().nonnegative().max(100_000),
    exhausted: z.number().int().nonnegative().max(100_000),
  })
  .strict();
export const WorkerRunCountsSchema = counts;
export type WorkerRunCounts = z.infer<typeof WorkerRunCountsSchema>;

export const AgentToolFactSchema = z
  .object({
    name: z.enum(AGENT_TOOL_NAMES),
    startedAt: utc,
    completedAt: utc.nullable(),
    durationMs: z.number().int().nonnegative().max(600_000).nullable(),
    outcome: z.enum(AGENT_RUN_OUTCOMES),
    errorClass: z.enum(AGENT_ERROR_CLASSES),
  })
  .strict();
export type AgentToolFact = z.infer<typeof AgentToolFactSchema>;

export const AdminAgentRunSchema = z
  .object({
    id: z.uuid(),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u),
    userId: AdminResourceIdSchema,
    modelId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u),
    startedAt: utc,
    completedAt: utc.nullable(),
    durationMs: z.number().int().nonnegative().max(600_000).nullable(),
    outcome: z.enum(AGENT_RUN_OUTCOMES),
    errorClass: z.enum(AGENT_ERROR_CLASSES),
    proposalId: AdminResourceIdSchema.nullable(),
    refundDraftId: AdminResourceIdSchema.nullable(),
    tools: z.array(AgentToolFactSchema).max(40),
  })
  .strict();
export type AdminAgentRun = z.infer<typeof AdminAgentRunSchema>;

function dateRangeIssue(value: { from?: string; to?: string }, ctx: z.RefinementCtx) {
  if ((value.from === undefined) !== (value.to === undefined)) {
    ctx.addIssue({ code: "custom", message: "Provide both dates." });
    return;
  }
  if (!value.from || !value.to) return;
  const from = Date.parse(value.from);
  const to = Date.parse(value.to);
  if (!(from < to) || to - from > 366 * 86_400_000) {
    ctx.addIssue({ code: "custom", message: "Invalid date range." });
  }
}

export const AdminAgentRunQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2048).optional(),
    userId: AdminResourceIdSchema.optional(),
    modelId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,64}$/u)
      .optional(),
    outcome: z.enum(AGENT_RUN_OUTCOMES).optional(),
    errorClass: z.enum(AGENT_ERROR_CLASSES).optional(),
    from: utc.optional(),
    to: utc.optional(),
  })
  .strict()
  .superRefine(dateRangeIssue);
export type AdminAgentRunQuery = z.infer<typeof AdminAgentRunQuerySchema>;

export const AdminAgentMetricsQuerySchema = z
  .object({
    from: utc.optional(),
    to: utc.optional(),
  })
  .strict()
  .superRefine(dateRangeIssue);
export type AdminAgentMetricsQuery = z.infer<typeof AdminAgentMetricsQuerySchema>;

const metric = z.object({
  value: z.number().finite().max(Number.MAX_SAFE_INTEGER).nullable(),
  availability: z.enum(["available", "unavailable"]),
  reason: z.string().max(300).nullable(),
  definition: z.string().min(1).max(500),
  unit: z.enum(["count", "minor"]).optional(),
  series: z
    .array(z.object({ key: z.string().min(1).max(64), value: z.number().finite() }))
    .max(40)
    .optional(),
});

export const AdminAgentMetricsSchema = z
  .object({
    asOf: utc,
    range: z.object({ from: utc, to: utc }).strict(),
    requests: metric,
    successfulRuns: metric,
    failedRuns: metric,
    latencyMs: metric,
    toolErrors: metric,
    refundDrafts: metric,
    errorClasses: metric,
  })
  .strict();
export type AdminAgentMetrics = z.infer<typeof AdminAgentMetricsSchema>;

function pick<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseAdminSystemHealth(value: unknown) {
  return pick(AdminSystemHealthSchema, value);
}
export function parseAdminWorkerHealth(value: unknown) {
  return pick(AdminWorkerHealthSchema, value);
}
export function parseAdminIntegrationHealth(value: unknown) {
  return pick(AdminIntegrationHealthSchema, value);
}
export function parseAdminAgentRun(value: unknown) {
  return pick(AdminAgentRunSchema, value);
}
export function parseAdminAgentMetrics(value: unknown) {
  return pick(AdminAgentMetricsSchema, value);
}
