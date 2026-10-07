import {
  ADMIN_APPROVAL_FUNNEL_KEYS,
  ADMIN_CHECKOUT_FUNNEL_KEYS,
  ADMIN_CHART_SERIES_MAX,
  boundChartSeries,
  errorCategoryKey,
  fillUtcDaySeries,
  normalizeFailureCode,
  topErrorCategories,
  utcDayKey,
  type AdminSeriesPoint,
} from "@mandatepay/shared";
import { Prisma } from "../generated/prisma/client.js";
import { getPrismaClient } from "../client.js";
import { minorNumber } from "./admin-query.js";

type Store = Prisma.TransactionClient | ReturnType<typeof getPrismaClient>;

type DayCount = { day: Date; count: bigint };
type DayAmount = { day: Date; amount: bigint };
type DayOutcome = { day: Date; outcome: string; count: bigint };

const nonSamplePayment = { isSample: false, proposal: { isSample: false } } as const;

export async function loadOverviewAnalytics(
  db: Store,
  from: Date,
  to: Date,
  asOf: Date,
): Promise<{
  capturedGrossByDay: AdminSeriesPoint[];
  approvalFunnel: AdminSeriesPoint[];
  checkoutFunnel: AdminSeriesPoint[];
  webhookDeliveriesByDay: AdminSeriesPoint[];
  webhookDeliveryOutcomes: AdminSeriesPoint[];
  agentRunsByDay: AdminSeriesPoint[];
  agentErrorClasses: AdminSeriesPoint[];
  topErrorCategories: AdminSeriesPoint[];
}> {
  const inRange = { gte: from, lt: to };
  const [
    capturedDays,
    approvalRow,
    checkoutRow,
    deliveryDays,
    deliveryOutcomes,
    agentDays,
    agentClasses,
    paymentErrors,
    refundErrors,
    webhookErrors,
  ] = await Promise.all([
    db.$queryRaw<DayAmount[]>(Prisma.sql`
      SELECT date_trunc('day', p."capturedAt") AS day, SUM(p.amount)::bigint AS amount
      FROM "Payment" p
      JOIN "PurchaseProposal" pr ON pr.id = p."proposalId"
      WHERE p.status IN ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
        AND p."paypalCaptureId" IS NOT NULL
        AND p."isSample" = false AND pr."isSample" = false
        AND p."capturedAt" >= ${from} AND p."capturedAt" < ${to}
      GROUP BY 1
      ORDER BY 1
    `),
    db.$queryRaw<
      Array<{
        created: bigint;
        require_approval: bigint;
        approval_created: bigint;
        approved: bigint;
        rejected: bigint;
        pending: bigint;
        expired: bigint;
      }>
    >(Prisma.sql`
      SELECT
        COUNT(*)::bigint AS created,
        COUNT(*) FILTER (WHERE latest.decision = 'REQUIRE_APPROVAL')::bigint AS require_approval,
        COUNT(*) FILTER (WHERE a.id IS NOT NULL AND a."isSample" = false)::bigint AS approval_created,
        COUNT(*) FILTER (WHERE a."isSample" = false AND a.decision = 'APPROVED')::bigint AS approved,
        COUNT(*) FILTER (WHERE a."isSample" = false AND a.decision = 'REJECTED')::bigint AS rejected,
        COUNT(*) FILTER (WHERE a."isSample" = false AND a.decision = 'PENDING' AND a."expiresAt" > ${asOf})::bigint AS pending,
        COUNT(*) FILTER (WHERE a."isSample" = false AND (a.decision = 'EXPIRED' OR (a.decision = 'PENDING' AND a."expiresAt" <= ${asOf})))::bigint AS expired
      FROM "PurchaseProposal" p
      LEFT JOIN LATERAL (
        SELECT d.decision
        FROM "PolicyDecision" d
        WHERE d."proposalId" = p.id
        ORDER BY d."createdAt" DESC, d.id DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN "Approval" a ON a."proposalId" = p.id
      WHERE p."isSample" = false AND p."createdAt" >= ${from} AND p."createdAt" < ${to}
    `),
    db.$queryRaw<
      Array<{
        created: bigint;
        policy_allow: bigint;
        order_created: bigint;
        provider_approved: bigint;
        captured: bigint;
        failed: bigint;
      }>
    >(Prisma.sql`
      SELECT
        COUNT(*)::bigint AS created,
        COUNT(*) FILTER (WHERE latest.decision = 'ALLOW')::bigint AS policy_allow,
        COUNT(*) FILTER (WHERE pay.id IS NOT NULL AND pay."isSample" = false AND pay."paypalOrderId" IS NOT NULL)::bigint AS order_created,
        COUNT(*) FILTER (WHERE pay."isSample" = false AND pay.status = 'APPROVED')::bigint AS provider_approved,
        COUNT(*) FILTER (WHERE pay."isSample" = false AND pay.status IN ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED') AND pay."paypalCaptureId" IS NOT NULL)::bigint AS captured,
        COUNT(*) FILTER (WHERE pay."isSample" = false AND pay.status IN ('DENIED', 'FAILED'))::bigint AS failed
      FROM "PurchaseProposal" p
      LEFT JOIN LATERAL (
        SELECT d.decision
        FROM "PolicyDecision" d
        WHERE d."proposalId" = p.id
        ORDER BY d."createdAt" DESC, d.id DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN "Payment" pay ON pay."proposalId" = p.id
      WHERE p."isSample" = false AND p."createdAt" >= ${from} AND p."createdAt" < ${to}
    `),
    db.$queryRaw<DayOutcome[]>(Prisma.sql`
      SELECT date_trunc('day', "receivedAt") AS day, outcome::text AS outcome, COUNT(*)::bigint AS count
      FROM "WebhookDeliveryMetric"
      WHERE "receivedAt" >= ${from} AND "receivedAt" < ${to}
      GROUP BY 1, 2
      ORDER BY 1
    `),
    db.webhookDeliveryMetric.groupBy({
      by: ["outcome"],
      where: { receivedAt: inRange },
      _count: true,
    }),
    db.$queryRaw<DayCount[]>(Prisma.sql`
      SELECT date_trunc('day', "startedAt") AS day, COUNT(*)::bigint AS count
      FROM "AgentRunMetric"
      WHERE "startedAt" >= ${from} AND "startedAt" < ${to}
      GROUP BY 1
      ORDER BY 1
    `),
    db.agentRunMetric.groupBy({
      by: ["errorClass"],
      where: { startedAt: inRange, outcome: "FAILED" },
      _count: true,
    }),
    db.payment.groupBy({
      by: ["failureCode"],
      where: { ...nonSamplePayment, status: { in: ["DENIED", "FAILED"] }, createdAt: inRange },
      _count: true,
    }),
    db.refund.groupBy({
      by: ["failureCode"],
      where: {
        isSample: false,
        status: "FAILED",
        createdAt: inRange,
        payment: nonSamplePayment,
      },
      _count: true,
    }),
    db.$queryRaw<Array<{ category: string; count: bigint }>>(Prisma.sql`
      SELECT category, COUNT(*)::bigint AS count
      FROM (
        SELECT CASE
          WHEN attempts >= 5 THEN 'WEBHOOK:RECOVERY_EXHAUSTED'
          WHEN "lastError" ~* 'timeout' THEN 'WEBHOOK:WEBHOOK_TIMEOUT'
          WHEN "lastError" ~* 'signature' THEN 'WEBHOOK:SIGNATURE_INVALID'
          WHEN "lastError" ~* 'pending|unknown outcome' THEN 'WEBHOOK:PROVIDER_PENDING'
          ELSE 'WEBHOOK:WEBHOOK_PROCESSING_FAILED'
        END AS category
        FROM "WebhookInbox"
        WHERE "signatureVerified" = true
          AND status = 'FAILED'
          AND "receivedAt" >= ${from} AND "receivedAt" < ${to}
      ) failed
      GROUP BY 1
    `),
  ]);
  const approval = approvalRow[0];
  const checkout = checkoutRow[0];
  const approvalFunnel = boundChartSeries(
    ADMIN_APPROVAL_FUNNEL_KEYS.map((key) => ({
      key,
      value: Number(
        key === "CREATED"
          ? (approval?.created ?? 0n)
          : key === "REQUIRE_APPROVAL"
            ? (approval?.require_approval ?? 0n)
            : key === "APPROVAL_CREATED"
              ? (approval?.approval_created ?? 0n)
              : key === "APPROVED"
                ? (approval?.approved ?? 0n)
                : key === "REJECTED"
                  ? (approval?.rejected ?? 0n)
                  : key === "PENDING"
                    ? (approval?.pending ?? 0n)
                    : (approval?.expired ?? 0n),
      ),
    })),
  );
  const checkoutFunnel = boundChartSeries(
    ADMIN_CHECKOUT_FUNNEL_KEYS.map((key) => ({
      key,
      value: Number(
        key === "CREATED"
          ? (checkout?.created ?? 0n)
          : key === "POLICY_ALLOW"
            ? (checkout?.policy_allow ?? 0n)
            : key === "ORDER_CREATED"
              ? (checkout?.order_created ?? 0n)
              : key === "PROVIDER_APPROVED"
                ? (checkout?.provider_approved ?? 0n)
                : key === "CAPTURED"
                  ? (checkout?.captured ?? 0n)
                  : (checkout?.failed ?? 0n),
      ),
    })),
  );
  const deliveryTotals = new Map<string, number>();
  for (const row of deliveryDays) {
    const key = utcDayKey(row.day);
    deliveryTotals.set(key, (deliveryTotals.get(key) ?? 0) + Number(row.count));
  }
  const agentErrorClasses = boundChartSeries(
    agentClasses.map((row) => ({
      key: errorCategoryKey("AGENT", row.errorClass).slice("AGENT:".length),
      value: row._count,
    })),
  );
  const errors: AdminSeriesPoint[] = [
    ...paymentErrors.map((row) => ({
      key: errorCategoryKey("PAY", normalizeFailureCode(row.failureCode) ?? "UNKNOWN"),
      value: row._count,
    })),
    ...refundErrors.map((row) => ({
      key: errorCategoryKey("REF", normalizeFailureCode(row.failureCode) ?? "UNKNOWN"),
      value: row._count,
    })),
    ...webhookErrors.map((row) => ({
      key: row.category.slice(0, 64),
      value: Number(row.count),
    })),
    ...agentClasses.map((row) => ({
      key: errorCategoryKey("AGENT", row.errorClass),
      value: row._count,
    })),
  ];
  return {
    capturedGrossByDay: fillUtcDaySeries(
      capturedDays.map((row) => ({
        key: utcDayKey(row.day),
        value: minorNumber(row.amount, "captured volume"),
      })),
      from,
      to,
      ADMIN_CHART_SERIES_MAX,
    ),
    approvalFunnel,
    checkoutFunnel,
    webhookDeliveriesByDay: fillUtcDaySeries(
      [...deliveryTotals.entries()].map(([key, value]) => ({ key, value })),
      from,
      to,
      ADMIN_CHART_SERIES_MAX,
    ),
    webhookDeliveryOutcomes: boundChartSeries(
      deliveryOutcomes.map((row) => ({ key: row.outcome, value: row._count })),
    ),
    agentRunsByDay: fillUtcDaySeries(
      agentDays.map((row) => ({ key: utcDayKey(row.day), value: Number(row.count) })),
      from,
      to,
      ADMIN_CHART_SERIES_MAX,
    ),
    agentErrorClasses,
    topErrorCategories: topErrorCategories(errors),
  };
}

export function explainCapturedVolumeSql(from: Date, to: Date) {
  return Prisma.sql`
    EXPLAIN (FORMAT JSON)
    SELECT date_trunc('day', p."capturedAt") AS day, SUM(p.amount)::bigint AS amount
    FROM "Payment" p
    JOIN "PurchaseProposal" pr ON pr.id = p."proposalId"
    WHERE p.status IN ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
      AND p."paypalCaptureId" IS NOT NULL
      AND p."isSample" = false AND pr."isSample" = false
      AND p."capturedAt" >= ${from} AND p."capturedAt" < ${to}
    GROUP BY 1
    ORDER BY 1
  `;
}

export function explainApprovalFunnelSql(from: Date, to: Date, asOf: Date) {
  return Prisma.sql`
    EXPLAIN (FORMAT JSON)
    SELECT COUNT(*)::bigint AS created
    FROM "PurchaseProposal" p
    LEFT JOIN LATERAL (
      SELECT d.decision
      FROM "PolicyDecision" d
      WHERE d."proposalId" = p.id
      ORDER BY d."createdAt" DESC, d.id DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN "Approval" a ON a."proposalId" = p.id
    WHERE p."isSample" = false AND p."createdAt" >= ${from} AND p."createdAt" < ${to}
      AND a."expiresAt" > ${asOf}
  `;
}
