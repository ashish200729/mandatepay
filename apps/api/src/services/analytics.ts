import {
  Prisma,
  PaymentStatus,
  PolicyDecisionType,
  RefundStatus,
  assertMinorUnits,
  type DatabaseClient,
} from "@mandatepay/database";

type Owner = { id: string };

const capturedPaymentStatuses: PaymentStatus[] = [
  PaymentStatus.COMPLETED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

const latestPolicyDecisionOrder: Prisma.PolicyDecisionOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

const transactionInclude = {
  productSnapshot: true,
  mandateVersion: true,
  policyDecisions: { orderBy: latestPolicyDecisionOrder, take: 1 },
  approval: true,
  payment: { include: { refunds: { orderBy: { createdAt: "asc" as const } } } },
} as const;

type TransactionRecord = Prisma.PurchaseProposalGetPayload<{ include: typeof transactionInclude }>;

export interface DashboardFilters {
  readonly minAmountMinor?: number;
  readonly maxAmountMinor?: number;
  readonly minAmountExclusive?: boolean;
  readonly maxAmountExclusive?: boolean;
  readonly decision?: PolicyDecisionType;
  readonly category?: string;
  readonly status?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit: number;
  readonly cursor?: { activityAt: Date; id: string };
}

export interface DashboardQueryParserInput {
  readonly query: string;
  readonly now: string;
}

function minor(value: bigint, field: string): number {
  assertMinorUnits(value, field);
  return Number(value);
}

function latestDecision(proposal: TransactionRecord): PolicyDecisionType | null {
  return proposal.policyDecisions[0]?.decision ?? null;
}

function transactionAmount(proposal: TransactionRecord): bigint {
  return proposal.payment?.amount ?? proposal.total;
}

function approvalType(proposal: TransactionRecord): string | null {
  if (proposal.approval?.decision === "APPROVED") return "HUMAN_APPROVED";
  if (latestDecision(proposal) === PolicyDecisionType.ALLOW) return "AUTO_APPROVED";
  if (latestDecision(proposal) === PolicyDecisionType.REQUIRE_APPROVAL) {
    return proposal.approval?.decision === "PENDING" ? "PENDING_APPROVAL" : "REQUIRE_APPROVAL";
  }
  if (latestDecision(proposal) === PolicyDecisionType.BLOCK) return "BLOCKED";
  return null;
}

function serializeTransaction(proposal: TransactionRecord, activityAt: Date) {
  return {
    id: proposal.id,
    paymentId: proposal.payment?.id ?? null,
    createdAt: proposal.createdAt.toISOString(),
    capturedAt: proposal.payment?.capturedAt?.toISOString() ?? null,
    activityAt: activityAt.toISOString(),
    dateBasis: proposal.payment?.capturedAt ? "CAPTURED" : "PROPOSED",
    product: {
      title: proposal.productSnapshot.title,
      brand: proposal.productSnapshot.brand,
      condition: proposal.productSnapshot.condition,
    },
    merchant: proposal.productSnapshot.merchant,
    category: proposal.productSnapshot.category,
    amountMinor: minor(transactionAmount(proposal), "transaction amount"),
    currency: proposal.currency,
    mandate: {
      title: proposal.mandateVersion.title,
      version: proposal.mandateVersion.version,
    },
    decision: latestDecision(proposal),
    approvalType: approvalType(proposal),
    paypalStatus: proposal.payment?.status ?? null,
  };
}

function encodeCursor(cursor: { activityAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ activityAt: cursor.activityAt.toISOString(), id: cursor.id }),
  ).toString("base64url");
}

export function decodeDashboardCursor(value: string): { activityAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      activityAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.activityAt !== "string" || typeof parsed.id !== "string") return null;
    const activityAt = new Date(parsed.activityAt);
    if (Number.isNaN(activityAt.getTime()) || parsed.id.length < 1 || parsed.id.length > 255)
      return null;
    return { activityAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function listAuditEvents(database: DatabaseClient, user: Owner, entityId?: string) {
  let entityIds = entityId ? [entityId] : undefined;
  if (entityId) {
    const payment = await database.payment.findFirst({
      where: { id: entityId, userId: user.id, isSample: false },
      select: {
        id: true,
        mandateId: true,
        proposalId: true,
        proposal: {
          select: {
            id: true,
            mandateId: true,
            mandateVersionId: true,
            productSnapshotId: true,
            approval: { select: { id: true } },
            reservation: { select: { id: true } },
          },
        },
        refunds: { where: { isSample: false }, select: { id: true } },
      },
    });
    if (payment) {
      entityIds = [
        payment.id,
        payment.mandateId,
        payment.proposalId,
        payment.proposal.mandateVersionId,
        payment.proposal.productSnapshotId,
        ...(payment.proposal.approval ? [payment.proposal.approval.id] : []),
        ...(payment.proposal.reservation ? [payment.proposal.reservation.id] : []),
        ...payment.refunds.map((refund) => refund.id),
      ];
    }
  }
  const events = await database.auditEvent.findMany({
    where: {
      userId: user.id,
      isSample: false,
      ...(entityIds ? { entityId: { in: entityIds } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: entityId ? 1_000 : 500,
  });
  return {
    events: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      createdAt: event.createdAt.toISOString(),
      payload: sanitizePublicPayload(event.payload),
    })),
  };
}

const publicPayloadKeys = new Set([
  "decision",
  "reasonCodes",
  "rulesSnapshot",
  "spendSnapshot",
  "amount",
  "amountMinor",
  "currency",
  "status",
  "source",
  "mode",
  "previous",
  "next",
  "version",
  "mandateId",
  "mandateVersionId",
  "proposalId",
  "paymentId",
  "refundId",
  "productSnapshotId",
  "queryHash",
  "total",
  "failureCode",
  "reasonCode",
  "category",
  "capturedAt",
  "settledAt",
  "from",
  "to",
]);

function sanitizePublicPayload(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (Array.isArray(value))
    return value.slice(0, 50).map((entry) => sanitizePublicPayload(entry, depth + 1));
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (!value || typeof value !== "object") return null;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (!publicPayloadKeys.has(key)) continue;
    result[key] = sanitizePublicPayload(entry, depth + 1);
  }
  return result;
}

async function ownedProposals(database: DatabaseClient, user: Owner, take = 501) {
  const proposals = await database.purchaseProposal.findMany({
    where: {
      userId: user.id,
      isSample: false,
    },
    include: transactionInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(take > 0 ? { take } : {}),
  });
  return proposals.filter((proposal) => proposal.payment?.isSample !== true);
}

export async function dashboardSummary(database: DatabaseClient, user: Owner) {
  const [policyCounts, paymentAggregate, refundAggregate, humanApproved, activeMandates] =
    await Promise.all([
      database.$queryRaw<Array<{ decision: string; count: bigint }>>(Prisma.sql`
        WITH latest_decisions AS (
          SELECT DISTINCT ON ("proposalId") "proposalId", "decision"
          FROM "PolicyDecision"
          ORDER BY "proposalId", "createdAt" DESC, "id" DESC
        )
        SELECT ld."decision"::text AS decision, COUNT(*)::bigint AS count
        FROM latest_decisions ld
        JOIN "PurchaseProposal" p ON p.id = ld."proposalId"
        LEFT JOIN "Payment" pay ON pay."proposalId" = p.id
        WHERE p."userId" = ${user.id}
          AND p."isSample" = false
          AND (pay.id IS NULL OR pay."isSample" = false)
        GROUP BY ld."decision"
      `),
      database.payment.aggregate({
        where: {
          userId: user.id,
          isSample: false,
          status: { in: capturedPaymentStatuses },
          capturedAt: { not: null },
          proposal: { isSample: false },
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      database.refund.aggregate({
        where: {
          userId: user.id,
          isSample: false,
          status: RefundStatus.COMPLETED,
          payment: { isSample: false, proposal: { isSample: false } },
        },
        _sum: { amount: true },
      }),
      database.approval.count({
        where: {
          userId: user.id,
          isSample: false,
          decision: "APPROVED",
          proposal: { isSample: false },
        },
      }),
      database.mandate.count({ where: { userId: user.id, status: "ACTIVE" } }),
    ]);
  const policyCount = (decision: PolicyDecisionType) =>
    Number(policyCounts.find((entry) => entry.decision === decision)?.count ?? 0n);
  return {
    totals: {
      purchases: paymentAggregate._count._all,
      policyAllowed: policyCount(PolicyDecisionType.ALLOW),
      humanApproved,
      blocked: policyCount(PolicyDecisionType.BLOCK),
      spendMinor: minor(paymentAggregate._sum.amount ?? 0n, "spend"),
      refundsMinor: minor(refundAggregate._sum.amount ?? 0n, "refund"),
      activeMandates,
    },
  };
}

export async function dashboardTransactions(
  database: DatabaseClient,
  user: Owner,
  filters: DashboardFilters,
) {
  const conditions = [
    Prisma.sql`p."userId" = ${user.id}`,
    Prisma.sql`p."isSample" = false`,
    Prisma.sql`(pay.id IS NULL OR pay."isSample" = false)`,
  ];
  if (filters.since)
    conditions.push(Prisma.sql`COALESCE(pay."capturedAt", p."createdAt") >= ${filters.since}`);
  if (filters.until)
    conditions.push(Prisma.sql`COALESCE(pay."capturedAt", p."createdAt") <= ${filters.until}`);
  if (filters.minAmountMinor !== undefined) {
    const operator = filters.minAmountExclusive ? Prisma.sql`>` : Prisma.sql`>=`;
    conditions.push(
      Prisma.sql`COALESCE(pay."amount", p."total") ${operator} ${BigInt(filters.minAmountMinor)}`,
    );
  }
  if (filters.maxAmountMinor !== undefined) {
    const operator = filters.maxAmountExclusive ? Prisma.sql`<` : Prisma.sql`<=`;
    conditions.push(
      Prisma.sql`COALESCE(pay."amount", p."total") ${operator} ${BigInt(filters.maxAmountMinor)}`,
    );
  }
  if (filters.category) conditions.push(Prisma.sql`ps."category" = ${filters.category}`);
  if (filters.decision) {
    conditions.push(Prisma.sql`ld."decision" = CAST(${filters.decision} AS "PolicyDecisionType")`);
  }
  if (filters.status) {
    conditions.push(Prisma.sql`COALESCE(pay."status"::text, p."status"::text) = ${filters.status}`);
  }
  if (filters.cursor) {
    conditions.push(
      Prisma.sql`(
        COALESCE(pay."capturedAt", p."createdAt") < ${filters.cursor.activityAt}
        OR (
          COALESCE(pay."capturedAt", p."createdAt") = ${filters.cursor.activityAt}
          AND p.id < ${filters.cursor.id}
        )
      )`,
    );
  }
  const rows = await database.$queryRaw<Array<{ id: string; activityAt: Date }>>(Prisma.sql`
    WITH latest_decisions AS (
      SELECT DISTINCT ON ("proposalId") "proposalId", "decision"
      FROM "PolicyDecision"
      ORDER BY "proposalId", "createdAt" DESC, "id" DESC
    )
    SELECT p.id, COALESCE(pay."capturedAt", p."createdAt") AS "activityAt"
    FROM "PurchaseProposal" p
    JOIN "ProductSnapshot" ps ON ps.id = p."productSnapshotId"
    LEFT JOIN "Payment" pay ON pay."proposalId" = p.id
    LEFT JOIN latest_decisions ld ON ld."proposalId" = p.id
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY "activityAt" DESC, p.id DESC
    LIMIT ${filters.limit + 1}
  `);
  const ids = rows.map((row) => row.id);
  const proposals = ids.length
    ? await database.purchaseProposal.findMany({
        where: { userId: user.id, id: { in: ids }, isSample: false },
        include: transactionInclude,
      })
    : [];
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  const pageRows = rows.slice(0, filters.limit);
  const hasNext = rows.length > filters.limit;
  const last = pageRows.at(-1);
  return {
    transactions: pageRows
      .map((row) => {
        const proposal = byId.get(row.id);
        return proposal ? serializeTransaction(proposal, row.activityAt) : null;
      })
      .filter((row): row is ReturnType<typeof serializeTransaction> => row !== null),
    nextCursor: hasNext && last ? encodeCursor({ activityAt: last.activityAt, id: last.id }) : null,
  };
}

export async function dashboardPolicyEvents(database: DatabaseClient, user: Owner) {
  const proposals = await ownedProposals(database, user, 0);
  return {
    events: proposals
      .filter((proposal) => latestDecision(proposal) === PolicyDecisionType.BLOCK)
      .map((proposal) => {
        const decision = proposal.policyDecisions[0];
        return {
          id: decision?.id ?? proposal.id,
          proposalId: proposal.id,
          createdAt: decision?.createdAt.toISOString() ?? proposal.updatedAt.toISOString(),
          product: {
            title: proposal.productSnapshot.title,
            merchant: proposal.productSnapshot.merchant,
            category: proposal.productSnapshot.category,
          },
          mandate: {
            title: proposal.mandateVersion.title,
            version: proposal.mandateVersion.version,
          },
          reasonCodes: decision?.reasonCodes ?? [],
          rulesSnapshot: decision?.rulesSnapshot ?? null,
        };
      }),
  };
}
