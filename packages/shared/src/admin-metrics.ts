export const ADMIN_CHART_SERIES_MAX = 400;
export const ADMIN_TOP_ERROR_LIMIT = 12;
export const ADMIN_OVERVIEW_RANGE_PRESETS = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "365d", label: "Last 365 days", days: 365 },
] as const;
export type AdminOverviewRangePresetId = (typeof ADMIN_OVERVIEW_RANGE_PRESETS)[number]["id"];

export const ADMIN_APPROVAL_FUNNEL_KEYS = [
  "CREATED",
  "REQUIRE_APPROVAL",
  "APPROVAL_CREATED",
  "APPROVED",
  "REJECTED",
  "PENDING",
  "EXPIRED",
] as const;
export const ADMIN_CHECKOUT_FUNNEL_KEYS = [
  "CREATED",
  "POLICY_ALLOW",
  "ORDER_CREATED",
  "PROVIDER_APPROVED",
  "CAPTURED",
  "FAILED",
] as const;

export const ADMIN_METRIC_DEFINITIONS = {
  totalUsers: "All user accounts as of the snapshot, including demo accounts.",
  verifiedUsers: "Users with verified email as of the snapshot.",
  autonomousUsers: "Users with global autonomous purchasing enabled as of the snapshot.",
  newUsersByDay: "Users created in the selected UTC range, bucketed by createdAt day.",
  activeMandates: "Mandates stored ACTIVE whose validity window includes the snapshot time.",
  mandateStatusDistribution:
    "Stored mandate status counts plus a separately labelled effectively-expired count.",
  activeProposals:
    "Non-sample proposals in in-flight states whose expiry is null or still in the future.",
  approvalRequiredProposals:
    "Non-sample proposals created in range whose latest policy decision is REQUIRE_APPROVAL.",
  pendingApprovals: "Non-sample pending approvals whose deadline is still after the snapshot.",
  overdueApprovals: "Non-sample pending approvals whose deadline is at or before the snapshot.",
  ordersCreated:
    "Non-sample payments with a PayPal order ID created in range, labelled by internal creation time.",
  capturedPayments:
    "Non-sample captured payments (completed or refunded) whose capture time falls in range.",
  capturedGrossMinor: "Original captured amount in range. Refunds do not reduce this gross.",
  capturedGrossByDay:
    "Original captured amount bucketed by UTC capturedAt day. Refunds do not reduce this gross.",
  paymentFailures:
    "Non-sample DENIED or FAILED payments created in range. CAPTURE_PENDING is not a failure.",
  refundsMinor: "Completed non-sample refund amounts with settlement time in range.",
  refundsByDay: "Completed refund amounts bucketed by UTC settlement day.",
  netCapturedMinor:
    "Captured gross minus completed refunds for this window. This is cash flow, not restored mandate allowance.",
  policyDistribution: "One latest policy decision per non-sample proposal created in range.",
  approvalFunnel:
    "Current approval outcomes for non-sample proposals created in range. Intermediate conversion times are not stored.",
  checkoutFunnel:
    "Current payment outcomes for non-sample proposals created in range. Linked order and capture rows only; CAPTURE_PENDING is omitted.",
  webhookFailures: "Verified durable inbox rows currently in FAILED status.",
  webhookStatusCounts: "Verified durable inbox rows grouped by persisted status.",
  webhookDeliveriesByDay: "Webhook delivery attempts bucketed by UTC received day.",
  webhookDeliveryOutcomes:
    "Webhook delivery attempts in range grouped by REJECTED, ACCEPTED, or DUPLICATE.",
  recoveryQueueDepth:
    "Verified PayPal rows eligible now: due FAILED or stale PROCESSING, attempts under five.",
  scheduledRetries: "Verified FAILED rows with a future retry schedule and attempts under five.",
  staleLeases: "Verified PROCESSING rows whose lease is older than five minutes.",
  exhausted: "Verified FAILED rows that have reached five recovery attempts.",
  lastWebhookProcessedAt:
    "Latest processedAt among PROCESSED inbox rows. This is not a worker heartbeat.",
  agentProposalCount:
    "PRODUCT_SELECTED audits with model_selected_server_validated_product in range, labelled as recorded agent selections.",
  agentRequests:
    "Agent runs started in the selected range. This is recorded operational telemetry, not chat text.",
  agentRunsByDay: "Agent runs started in range, bucketed by UTC startedAt day.",
  agentErrorClasses: "Failed agent runs in range grouped by safe error class.",
  successfulRuns: "Agent runs that completed successfully in range.",
  failedRuns: "Agent runs that failed in range.",
  latency: "Average recorded agent-run duration in the selected range.",
  toolErrors: "Agent tool calls that failed in range.",
  refundDrafts: "Agent runs that prepared a refund-draft payment identifier in range.",
  topErrorCategories:
    "Top closed payment, refund, webhook, and agent error classes in range. Raw provider messages are not returned.",
  rejectedWebhookDeliveries:
    "Webhook delivery attempts rejected before or during verification, in range.",
  duplicateDeliveries:
    "Repeated webhook deliveries for an event that was already accepted, in range.",
  lastSuccessfulReconcile:
    "Latest successful admin reconciliation audit. This is not a historical provider-health series.",
  disabledUsers:
    "User rows with disabledAt set. As-of count, including test/demo accounts because no User sample marker exists.",
  adminActions: "Admin audit events created in the selected range.",
} as const;
export type AdminMetricDefinitionKey = keyof typeof ADMIN_METRIC_DEFINITIONS;

export const ADMIN_OVERVIEW_CHART_METRIC_KEYS = [
  "newUsersByDay",
  "capturedGrossByDay",
  "refundsByDay",
  "policyDistribution",
  "approvalFunnel",
  "checkoutFunnel",
  "webhookStatusCounts",
  "webhookDeliveriesByDay",
  "webhookDeliveryOutcomes",
  "topErrorCategories",
  "mandateStatusDistribution",
  "agentRunsByDay",
  "agentErrorClasses",
] as const satisfies readonly AdminMetricDefinitionKey[];

export type AdminSeriesPoint = { key: string; value: number };

export function overviewRangeFromPreset(days: number, asOf: Date) {
  return {
    from: new Date(asOf.getTime() - days * 86_400_000).toISOString(),
    to: asOf.toISOString(),
  };
}

export function matchingOverviewPreset(from: string, to: string, asOf: string) {
  const duration = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(duration) || Math.abs(Date.parse(to) - Date.parse(asOf)) > 120_000)
    return null;
  for (const preset of ADMIN_OVERVIEW_RANGE_PRESETS) {
    if (Math.abs(duration - preset.days * 86_400_000) < 1_000) return preset.id;
  }
  return null;
}

export function utcDayKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function fillUtcDaySeries(
  rows: readonly AdminSeriesPoint[],
  from: Date,
  to: Date,
  max = ADMIN_CHART_SERIES_MAX,
): AdminSeriesPoint[] {
  if (!(from < to) || max < 1) return [];
  const counts = new Map(rows.map((row) => [row.key, row.value]));
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const last = new Date(to.getTime() - 1);
  const end = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
  const series: AdminSeriesPoint[] = [];
  for (let time = start; time <= end && series.length < max; time += 86_400_000) {
    const key = new Date(time).toISOString().slice(0, 10);
    series.push({ key, value: counts.get(key) ?? 0 });
  }
  return series;
}

export function boundChartSeries(rows: readonly AdminSeriesPoint[], max = ADMIN_CHART_SERIES_MAX) {
  return rows.slice(0, max);
}

export function errorCategoryKey(source: "AGENT" | "PAY" | "REF" | "WEBHOOK", code: string) {
  const prefix = `${source}:`;
  const body = (code.replace(/[^A-Z0-9_]/gu, "").slice(0, 64 - prefix.length) || "UNKNOWN").slice(
    0,
    64 - prefix.length,
  );
  return `${prefix}${body}`;
}

export function topErrorCategories(
  rows: readonly AdminSeriesPoint[],
  limit = ADMIN_TOP_ERROR_LIMIT,
) {
  const merged = new Map<string, number>();
  for (const row of rows) {
    const key = row.key.slice(0, 64);
    merged.set(key, (merged.get(key) ?? 0) + row.value);
  }
  return [...merged.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key))
    .slice(0, limit);
}
