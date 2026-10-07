import {
  ADMIN_CSV_MAX_ROWS,
  ACTIVE_PROPOSAL_STATUSES,
  CAPTURED_PAYMENT_STATUSES,
  HIGH_RISK_ADMIN_ACTIONS,
  HIGH_RISK_DOMAIN_EVENTS,
  checkoutEligibility,
  describePlatformMode,
  normalizeFailureCode,
  parseCanonicalRules,
  parseDomainFacts,
  parseReasonCodes,
  parseSpendProjection,
  paymentReconciliation,
  restrictiveControlCount,
  resolvePlatformControls,
  safeAdminText,
  webhookErrorCode,
  workerLiveness,
  type AdminActivityQuery,
  type AdminApprovalQuery,
  type AdminDomainAuditQuery,
  type AdminMandateQuery,
  type AdminOrderQuery,
  type AdminNoteQuery,
  type AdminOverviewQuery,
  type AdminPaymentQuery,
  type AdminProposalQuery,
  type AdminRefundQuery,
  type AdminUserQuery,
  type AdminUserSessionQuery,
  type AdminWebhookQuery,
} from "@mandatepay/shared";
import { Prisma } from "../generated/prisma/client.js";
import { getPrismaClient } from "../client.js";
import { DatabaseError } from "../errors.js";
import { ObservabilityRepository } from "./observability-repository.js";
import {
  activeMandateWhere,
  decodeCursor,
  defaultOverviewRange,
  encodeCursor,
  iso,
  minorNumber,
  optionalMinor,
  ownerDto,
  providerIdsFromPayload,
  queryBinding,
  recoveryWhere,
  requireId,
  sampleParent,
  timestampPage,
  webhookDiagnostics,
  WEBHOOK_LEASE_MS,
  WEBHOOK_MAX_ATTEMPTS,
} from "./admin-query.js";

type Store = Prisma.TransactionClient | ReturnType<typeof getPrismaClient>;
const captured = [...CAPTURED_PAYMENT_STATUSES];
const activeProposals = [...ACTIVE_PROPOSAL_STATUSES];
const ownerSelect = { id: true, name: true, email: true } as const;
const productSelect = {
  id: true,
  source: true,
  externalId: true,
  title: true,
  brand: true,
  category: true,
  condition: true,
  merchant: true,
  price: true,
  currency: true,
  capturedAt: true,
} as const;

function metric(
  value: number | bigint | null,
  definition: string,
  extra: {
    unit?: "count" | "minor";
    series?: { key: string; value: number }[];
    reason?: string;
  } = {},
) {
  const numeric =
    value === null ? null : typeof value === "bigint" ? minorNumber(value, "metric") : value;
  if (numeric !== null && !Number.isSafeInteger(numeric))
    throw new DatabaseError("INVALID_MONEY", "Metric exceeds the supported integer range.");
  return {
    value: numeric,
    availability: "available" as const,
    reason: extra.reason ?? null,
    definition,
    ...(extra.unit ? { unit: extra.unit } : {}),
    ...(extra.series ? { series: extra.series } : {}),
  };
}
function unavailable(definition: string, reason: string) {
  return { value: null, availability: "unavailable" as const, reason, definition };
}
async function platformControlMetric(db: {
  platformSetting: {
    findMany(args: {
      select: { key: true; valueJson: true };
    }): Promise<ReadonlyArray<{ key: string; valueJson: unknown }>>;
  };
}) {
  try {
    const rows = await db.platformSetting.findMany({ select: { key: true, valueJson: true } });
    const controls = resolvePlatformControls(rows);
    return metric(
      restrictiveControlCount(controls),
      "Count of platform controls that differ from normal operation. Zero means maintenance is off and the other switches are on.",
      { reason: describePlatformMode(controls) },
    );
  } catch {
    return unavailable("Platform kill-switch state.", "Platform settings could not be read.");
  }
}
function directionOf(value?: "asc" | "desc", fallback: "asc" | "desc" = "desc") {
  return value ?? fallback;
}
function capability(
  action:
    | "users:disable"
    | "users:enable"
    | "users:revoke-sessions"
    | "users:disable-autonomy"
    | "users:notes"
    | "mandates:pause"
    | "mandates:revoke"
    | "proposals:re-evaluate"
    | "orders:reconcile"
    | "payments:reconcile"
    | "payments:refund"
    | "refunds:refresh"
    | "webhooks:retry"
    | "webhooks:reconcile",
  allowed: boolean,
  reason: string | null = null,
) {
  return { action, allowed, reason: allowed ? null : reason };
}
function userCapabilities(input: {
  disabled: boolean;
  isAdmin: boolean;
  autonomyEnabled: boolean;
}) {
  const lockout = "The singleton administrator account cannot be disabled.";
  return [
    capability(
      "users:disable",
      !input.disabled && !input.isAdmin,
      input.isAdmin ? lockout : "This account is already disabled.",
    ),
    capability(
      "users:enable",
      input.disabled,
      input.disabled ? null : "This account is already enabled.",
    ),
    capability("users:revoke-sessions", true),
    capability(
      "users:disable-autonomy",
      input.autonomyEnabled,
      "Autonomous purchasing is already off.",
    ),
    capability("users:notes", true),
  ];
}
function mandateCapabilities(status: string) {
  return [
    capability(
      "mandates:pause",
      status === "ACTIVE",
      "Pause is only available for an active mandate.",
    ),
    capability(
      "mandates:revoke",
      ["DRAFT", "ACTIVE", "PAUSED", "EXPIRED"].includes(status),
      "This mandate is already revoked.",
    ),
  ];
}
function proposalCapabilities(status: string, isSample: boolean) {
  const allowed = !isSample && ["PROPOSED", "POLICY_CHECKED", "AWAITING_APPROVAL"].includes(status);
  return [
    capability(
      "proposals:re-evaluate",
      allowed,
      isSample
        ? "Sample proposals cannot be targeted by controls."
        : "Re-evaluation is limited to current AgentGuard evaluation states. BLOCKED and terminal proposals cannot be reset.",
    ),
  ];
}
function paymentCapabilities(input: {
  isSample: boolean;
  status: string;
  remainingRefundableMinor: number;
  hasPaypalOrderId: boolean;
}) {
  const sample = "Sample payments cannot be targeted by financial controls.";
  const reconcileAllowed = !input.isSample && input.hasPaypalOrderId;
  const refundAllowed =
    !input.isSample &&
    ["COMPLETED", "PARTIALLY_REFUNDED"].includes(input.status) &&
    input.remainingRefundableMinor > 0;
  return [
    capability(
      "orders:reconcile",
      reconcileAllowed,
      input.isSample
        ? sample
        : "Reconciliation requires a PayPal order identifier. Provider truth is not invented locally.",
    ),
    capability(
      "payments:reconcile",
      reconcileAllowed,
      input.isSample
        ? sample
        : "Reconciliation requires a PayPal order identifier. Provider truth is not invented locally.",
    ),
    capability(
      "payments:refund",
      refundAllowed,
      input.isSample
        ? sample
        : "Refunds are limited to captured payments with remaining refundable amount.",
    ),
  ];
}
function refundCapabilities(input: { isSample: boolean; status: string }) {
  const allowed = !input.isSample && ["REQUESTED", "APPROVED", "SUBMITTED"].includes(input.status);
  return [
    capability(
      "refunds:refresh",
      allowed,
      input.isSample
        ? "Sample refunds cannot be targeted by financial controls."
        : "Status refresh is limited to known pending refunds.",
    ),
  ];
}
function webhookCapabilities(input: { retryEligible: boolean; paymentId: string | null }) {
  return [
    capability(
      "webhooks:retry",
      input.retryEligible,
      "Retry is limited to verified due failures or stale processing leases under the five-attempt cap.",
    ),
    capability(
      "webhooks:reconcile",
      Boolean(input.paymentId),
      "Linked reconciliation requires exactly one matching order or payment.",
    ),
  ];
}

export class AdminOperationsRepository {
  constructor(
    private readonly db: Store = getPrismaClient(),
    private readonly cursorSecret?: string,
  ) {}

  private secret() {
    if (!this.cursorSecret || this.cursorSecret.length < 32)
      throw new DatabaseError("INVALID_STATE", "Cursor configuration is unavailable.");
    return this.cursorSecret;
  }

  private page<
    T extends {
      id: string;
      createdAt?: Date | null;
      expiresAt?: Date | null;
      receivedAt?: Date | null;
      capturedAt?: Date | null;
    },
  >(
    rows: T[],
    limit: number,
    binding: string,
    field: "createdAt" | "expiresAt" | "receivedAt" | "capturedAt",
  ) {
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const stamp = last?.[field];
    const nextCursor =
      rows.length > limit && last && stamp instanceof Date
        ? encodeCursor(this.secret(), { at: iso(stamp), id: last.id, binding })
        : null;
    return { page, nextCursor, limit };
  }

  private boundary(cursor: string | undefined, binding: string) {
    return cursor ? decodeCursor(this.secret(), cursor, binding) : undefined;
  }

  async listUsers(query: AdminUserQuery, asOf = new Date()) {
    const { cursor, ...filters } = query;
    const binding = queryBinding({ ...filters, resource: "users" });
    const direction = directionOf(query.direction);
    const where: Prisma.UserWhereInput = {
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { email: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(query.verified === undefined ? {} : { emailVerified: query.verified }),
      ...(query.autonomy === undefined
        ? {}
        : { globalAutonomousPurchasingEnabled: query.autonomy }),
      ...(query.disabled === undefined
        ? {}
        : query.disabled
          ? { disabledAt: { not: null } }
          : { disabledAt: null }),
      ...(query.hasActiveMandate === undefined
        ? {}
        : {
            mandates: query.hasActiveMandate
              ? { some: activeMandateWhere(asOf) }
              : { none: activeMandateWhere(asOf) },
          }),
      ...(query.from ? { createdAt: { gte: new Date(query.from), lt: new Date(query.to!) } } : {}),
      ...timestampPage("createdAt", direction, this.boundary(cursor, binding)),
    };
    const rows = await this.db.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        globalAutonomousPurchasingEnabled: true,
        disabledAt: true,
        disabledReason: true,
        accessVersion: true,
        createdAt: true,
        updatedAt: true,
        adminPrincipal: { select: { id: true, active: true } },
        _count: {
          select: {
            mandates: { where: activeMandateWhere(asOf) },
            proposals: { where: { isSample: false } },
          },
        },
      },
      orderBy: [{ createdAt: direction }, { id: direction }],
      take: query.limit + 1,
    });
    const { page, nextCursor, limit } = this.page(rows, query.limit, binding, "createdAt");
    return { data: await this.usersDto(page, asOf), page: { limit, nextCursor } };
  }

  async getUser(userId: string, asOf = new Date()) {
    const row = await this.db.user.findUnique({
      where: { id: requireId(userId, "user") },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        globalAutonomousPurchasingEnabled: true,
        disabledAt: true,
        disabledReason: true,
        accessVersion: true,
        createdAt: true,
        updatedAt: true,
        adminPrincipal: { select: { id: true, active: true } },
        _count: {
          select: {
            mandates: { where: activeMandateWhere(asOf) },
            proposals: { where: { isSample: false } },
          },
        },
      },
    });
    if (!row) return null;
    return (await this.usersDto([row], asOf))[0] ?? null;
  }

  private async usersDto(
    rows: Array<{
      id: string;
      name: string | null;
      email: string;
      emailVerified: boolean;
      globalAutonomousPurchasingEnabled: boolean;
      disabledAt: Date | null;
      disabledReason: string | null;
      accessVersion: number;
      createdAt: Date;
      updatedAt: Date;
      adminPrincipal: { id: string; active: boolean } | null;
      _count: { mandates: number; proposals: number };
    }>,
    asOf: Date,
  ) {
    const ids = rows.map((row) => row.id);
    const [sessions, audits, capturedSpend] = ids.length
      ? await Promise.all([
          this.db.session.groupBy({
            by: ["userId"],
            where: { userId: { in: ids } },
            _max: { updatedAt: true },
          }),
          this.db.auditEvent.groupBy({
            by: ["userId"],
            where: { userId: { in: ids } },
            _max: { createdAt: true },
          }),
          this.db.payment.groupBy({
            by: ["userId"],
            where: {
              userId: { in: ids },
              isSample: false,
              status: { in: captured },
              proposal: { isSample: false },
            },
            _sum: { amount: true },
          }),
        ])
      : [[], [], []];
    const sessionAt = new Map(sessions.map((row) => [row.userId, row._max.updatedAt]));
    const auditAt = new Map(audits.map((row) => [row.userId, row._max.createdAt]));
    const spend = new Map(capturedSpend.map((row) => [row.userId, row._sum.amount ?? 0n]));
    return rows.map((row) => {
      const last = [row.updatedAt, sessionAt.get(row.id), auditAt.get(row.id)].filter(
        (value): value is Date => value instanceof Date,
      );
      const lastActivityAt = last.reduce(
        (latest, value) => (value > latest ? value : latest),
        row.updatedAt,
      );
      const disabled = row.disabledAt !== null;
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        emailVerified: row.emailVerified,
        autonomousPurchasingEnabled: row.globalAutonomousPurchasingEnabled,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
        accessVersion: row.accessVersion,
        activeMandateCount: row._count.mandates,
        proposalCount: row._count.proposals,
        capturedGrossMinor: minorNumber(spend.get(row.id) ?? 0n, "captured spend"),
        lastActivityAt: iso(lastActivityAt > asOf ? asOf : lastActivityAt),
        lastActivityBasis: "observed_activity_proxy" as const,
        accessStatus: disabled ? ("disabled" as const) : ("enabled" as const),
        accessStatusReason: disabled
          ? (safeAdminText(row.disabledReason, 255) ?? "This account is disabled.")
          : null,
        disabledAt: row.disabledAt ? iso(row.disabledAt) : null,
        capabilities: userCapabilities({
          disabled,
          isAdmin: Boolean(row.adminPrincipal?.active),
          autonomyEnabled: row.globalAutonomousPurchasingEnabled,
        }),
      };
    });
  }

  async listUserSessions(userId: string, query: AdminUserSessionQuery, asOf = new Date()) {
    requireId(userId, "user");
    const { cursor, ...filters } = query;
    const binding = queryBinding({ ...filters, userId, resource: "user-sessions" });
    const where: Prisma.SessionWhereInput = {
      userId,
      ...(query.live === undefined
        ? {}
        : query.live
          ? { expiresAt: { gt: asOf } }
          : { expiresAt: { lte: asOf } }),
      ...timestampPage("createdAt", "desc", this.boundary(cursor, binding)),
    };
    const rows = await this.db.session.findMany({
      where,
      select: { id: true, createdAt: true, updatedAt: true, expiresAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });
    const { page, nextCursor, limit } = this.page(rows, query.limit, binding, "createdAt");
    return {
      data: page.map((row) => ({
        id: row.id,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
        expiresAt: iso(row.expiresAt),
        isCurrent: row.expiresAt > asOf,
      })),
      page: { limit, nextCursor },
    };
  }

  async listUserNotes(userId: string, query: AdminNoteQuery) {
    requireId(userId, "user");
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return null;
    const { cursor, ...filters } = query;
    const binding = queryBinding({ ...filters, userId, resource: "user-notes" });
    const rows = await this.db.adminNote.findMany({
      where: {
        userId,
        ...timestampPage("createdAt", "desc", this.boundary(cursor, binding)),
      },
      select: {
        id: true,
        userId: true,
        body: true,
        authorAdminId: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });
    const { page, nextCursor, limit } = this.page(rows, query.limit, binding, "createdAt");
    const authors = page.length
      ? await this.db.adminPrincipal.findMany({
          where: { id: { in: page.map((row) => row.authorAdminId) } },
          select: { id: true, user: { select: { name: true } } },
        })
      : [];
    const names = new Map(authors.map((row) => [row.id, row.user.name]));
    return {
      data: page.map((row) => ({
        id: row.id,
        userId: row.userId,
        body: row.body,
        authorPrincipalId: row.authorAdminId,
        authorName: names.get(row.authorAdminId) ?? null,
        createdAt: iso(row.createdAt),
      })),
      page: { limit, nextCursor },
    };
  }

  async listMandates(query: AdminMandateQuery, asOf = new Date()) {
    const { cursor, ...filters } = query;
    const binding = queryBinding({ ...filters, resource: "mandates" });
    const direction = directionOf(query.direction);
    const where: Prisma.MandateWhereInput = {
      ...(query.q ? { title: { contains: query.q, mode: "insensitive" } } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.effectiveExpired === undefined
        ? {}
        : query.effectiveExpired
          ? { expiresAt: { lte: asOf } }
          : { expiresAt: { gt: asOf } }),
      ...(query.from ? { createdAt: { gte: new Date(query.from), lt: new Date(query.to!) } } : {}),
      ...timestampPage("createdAt", direction, this.boundary(cursor, binding)),
    };
    const rows = await this.db.mandate.findMany({
      where,
      select: mandateSelect,
      orderBy: [{ createdAt: direction }, { id: direction }],
      take: query.limit + 1,
    });
    const { page, nextCursor, limit } = this.page(rows, query.limit, binding, "createdAt");
    return { data: page.map((row) => this.mandateDto(row, asOf)), page: { limit, nextCursor } };
  }

  async getMandate(mandateId: string, asOf = new Date()) {
    const row = await this.db.mandate.findUnique({
      where: { id: requireId(mandateId, "mandate") },
      select: mandateSelect,
    });
    return row ? this.mandateDto(row, asOf) : null;
  }

  private mandateDto(row: Prisma.MandateGetPayload<{ select: typeof mandateSelect }>, asOf: Date) {
    if (row.currency !== "USD" || row.spendTimeZone !== "UTC")
      throw new DatabaseError("INVALID_STATE", "Mandate currency or timezone is unsupported.");
    const version = row.activeVersion ?? row.versions[0] ?? null;
    return {
      id: row.id,
      owner: ownerDto(row.user),
      title: row.title,
      status: row.status,
      version: row.version,
      activeVersionId: row.activeVersionId,
      currency: "USD" as const,
      autoSpendLimitMinor: minorNumber(row.autoSpendLimit, "auto spend"),
      transactionLimitMinor: minorNumber(row.transactionLimit, "transaction limit"),
      dailyLimitMinor: optionalMinor(row.dailyLimit, "daily limit"),
      weeklyLimitMinor: optionalMinor(row.weeklyLimit, "weekly limit"),
      monthlyLimitMinor: optionalMinor(row.monthlyLimit, "monthly limit"),
      spendTimeZone: "UTC" as const,
      startsAt: iso(row.startsAt),
      expiresAt: iso(row.expiresAt),
      effectiveExpired: row.expiresAt <= asOf,
      rules: parseCanonicalRules(version?.canonicalRules),
      relatedProposalCount: row._count.proposals,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      capabilities: mandateCapabilities(row.status),
    };
  }

  async listMandateVersions(mandateId: string, query: { limit: number; cursor?: string }) {
    requireId(mandateId, "mandate");
    const binding = queryBinding({ mandateId, limit: query.limit, resource: "mandate-versions" });
    const rows = await this.db.mandateVersion.findMany({
      where: {
        mandateId,
        ...timestampPage("createdAt", "desc", this.boundary(query.cursor, binding)),
      },
      select: mandateVersionSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });
    const { page, nextCursor, limit } = this.page(rows, query.limit, binding, "createdAt");
    return {
      data: page.map((row) => {
        if (row.currency !== "USD" || row.spendTimeZone !== "UTC")
          throw new DatabaseError(
            "INVALID_STATE",
            "Mandate version currency or timezone is unsupported.",
          );
        return {
          id: row.id,
          mandateId: row.mandateId,
          version: row.version,
          title: row.title,
          currency: "USD" as const,
          autoSpendLimitMinor: minorNumber(row.autoSpendLimit, "auto spend"),
          transactionLimitMinor: minorNumber(row.transactionLimit, "transaction limit"),
          dailyLimitMinor: optionalMinor(row.dailyLimit, "daily limit"),
          weeklyLimitMinor: optionalMinor(row.weeklyLimit, "weekly limit"),
          monthlyLimitMinor: optionalMinor(row.monthlyLimit, "monthly limit"),
          spendTimeZone: "UTC" as const,
          startsAt: iso(row.startsAt),
          expiresAt: iso(row.expiresAt),
          rules: parseCanonicalRules(row.canonicalRules),
          createdAt: iso(row.createdAt),
        };
      }),
      page: { limit, nextCursor },
    };
  }

  async listProposals(query: AdminProposalQuery, asOf = new Date()) {
    const { cursor, ...filters } = query;
    const binding = queryBinding({ ...filters, resource: "proposals" });
    const direction = directionOf(query.direction);
    const includeSamples = query.includeSamples === true;
    const where: Prisma.PurchaseProposalWhereInput = {
      ...sampleParent(includeSamples),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.mandateId ? { mandateId: query.mandateId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { productSnapshot: { source: query.source } } : {}),
      ...(query.from ? { createdAt: { gte: new Date(query.from), lt: new Date(query.to!) } } : {}),
      ...timestampPage("createdAt", direction, this.boundary(cursor, binding)),
    };
    const take = query.decision ? Math.min(query.limit * 20, 500) : query.limit + 1;
    const rows = await this.db.purchaseProposal.findMany({
      where,
      select: proposalSelect,
      orderBy: [{ createdAt: direction }, { id: direction }],
      take,
    });
    const matched = query.decision
      ? rows.filter((row) => row.policyDecisions[0]?.decision === query.decision)
      : rows;
    const limited = matched.slice(0, query.limit + 1);
    const { page, nextCursor, limit } = this.page(limited, query.limit, binding, "createdAt");
    return { data: page.map((row) => this.proposalDto(row, asOf)), page: { limit, nextCursor } };
  }

  async getProposal(proposalId: string, asOf = new Date()) {
    const row = await this.db.purchaseProposal.findUnique({
      where: { id: requireId(proposalId, "proposal") },
      select: proposalSelect,
    });
    return row ? this.proposalDto(row, asOf) : null;
  }

  private proposalDto(
    row: Prisma.PurchaseProposalGetPayload<{ select: typeof proposalSelect }>,
    asOf: Date,
  ) {
    if (row.currency !== "USD" || row.productSnapshot.currency !== "USD")
      throw new DatabaseError("INVALID_CURRENCY", "Only USD proposals are supported.");
    const latest = row.policyDecisions[0];
    const eligibility = checkoutEligibility({
      source: row.productSnapshot.source,
      isSample: row.isSample,
      status: row.status,
      expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
      asOf,
    });
    return {
      id: row.id,
      owner: ownerDto(row.user),
      mandateId: row.mandateId,
      mandateVersionId: row.mandateVersionId,
      product: {
        id: row.productSnapshot.id,
        source: row.productSnapshot.source,
        externalId: row.productSnapshot.externalId,
        title: row.productSnapshot.title,
        brand: row.productSnapshot.brand,
        category: row.productSnapshot.category,
        condition: row.productSnapshot.condition,
        merchant: row.productSnapshot.merchant,
        priceMinor: minorNumber(row.productSnapshot.price, "product price"),
        currency: "USD" as const,
        capturedAt: iso(row.productSnapshot.capturedAt),
      },
      quantity: row.quantity,
      subtotalMinor: minorNumber(row.subtotal, "subtotal"),
      shippingMinor: minorNumber(row.shipping, "shipping"),
      taxMinor: minorNumber(row.tax, "tax"),
      totalMinor: minorNumber(row.total, "total"),
      currency: "USD" as const,
      status: row.status,
      expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
      latestDecision: latest
        ? {
            id: latest.id,
            proposalId: latest.proposalId,
            mandateVersionId: latest.mandateVersionId,
            decision: latest.decision,
            reasonCodes: parseReasonCodes(latest.reasonCodes),
            rules: parseCanonicalRules(latest.rulesSnapshot),
            spend: parseSpendProjection(latest.spendSnapshot),
            createdAt: iso(latest.createdAt),
          }
        : null,
      approvalId: row.approval?.id ?? null,
      paymentId: row.payment?.id ?? null,
      reservationId: row.reservation?.id ?? null,
      ...eligibility,
      isSample: row.isSample,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      capabilities: proposalCapabilities(row.status, row.isSample),
    };
  }

  async listProposalDecisions(proposalId: string, query: { limit: number; cursor?: string }) {
    requireId(proposalId, "proposal");
    const binding = queryBinding({
      proposalId,
      limit: query.limit,
      resource: "proposal-decisions",
    });
    const rows = await this.db.policyDecision.findMany({
      where: {
        proposalId,
        ...timestampPage("createdAt", "desc", this.boundary(query.cursor, binding)),
      },
      select: {
        id: true,
        proposalId: true,
        mandateVersionId: true,
        decision: true,
        reasonCodes: true,
        rulesSnapshot: true,
        spendSnapshot: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });
    const { page, nextCursor, limit } = this.page(rows, query.limit, binding, "createdAt");
    return {
      data: page.map((row) => ({
        id: row.id,
        proposalId: row.proposalId,
        mandateVersionId: row.mandateVersionId,
        decision: row.decision,
        reasonCodes: parseReasonCodes(row.reasonCodes),
        rules: parseCanonicalRules(row.rulesSnapshot),
        spend: parseSpendProjection(row.spendSnapshot),
        createdAt: iso(row.createdAt),
      })),
      page: { limit, nextCursor },
    };
  }

  async getProposalReservation(proposalId: string) {
    requireId(proposalId, "proposal");
    const row = await this.db.spendReservation.findUnique({
      where: { proposalId },
      select: {
        id: true,
        proposalId: true,
        mandateId: true,
        mandateVersionId: true,
        amount: true,
        currency: true,
        window: true,
        windowStart: true,
        windowEnd: true,
        status: true,
        expiresAt: true,
        releasedAt: true,
        consumedAt: true,
        isSample: true,
      },
    });
    if (!row) return null;
    if (row.currency !== "USD")
      throw new DatabaseError("INVALID_CURRENCY", "Only USD reservations are supported.");
    return {
      id: row.id,
      proposalId: row.proposalId,
      mandateId: row.mandateId,
      mandateVersionId: row.mandateVersionId,
      amountMinor: minorNumber(row.amount, "reservation"),
      currency: "USD" as const,
      window: row.window,
      windowStart: iso(row.windowStart),
      windowEnd: iso(row.windowEnd),
      status: row.status,
      expiresAt: iso(row.expiresAt),
      releasedAt: row.releasedAt ? iso(row.releasedAt) : null,
      consumedAt: row.consumedAt ? iso(row.consumedAt) : null,
      isSample: row.isSample,
    };
  }

  async listApprovals(query: AdminApprovalQuery, asOf = new Date()) {
    const { cursor, ...filters } = query;
    const sortField = query.sort === "createdAt" ? "createdAt" : "expiresAt";
    const direction = directionOf(query.direction, sortField === "expiresAt" ? "asc" : "desc");
    const binding = queryBinding({ ...filters, resource: "approvals" });
    const includeSamples = query.includeSamples === true;
    const where: Prisma.ApprovalWhereInput = {
      ...sampleParent(includeSamples),
      ...(includeSamples ? {} : { proposal: { isSample: false } }),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.proposalId ? { proposalId: query.proposalId } : {}),
      ...(query.decision ? { decision: query.decision } : {}),
      ...(query.effectiveExpired === undefined
        ? {}
        : query.effectiveExpired
          ? { expiresAt: { lte: asOf } }
          : { expiresAt: { gt: asOf } }),
      ...(query.from ? { expiresAt: { gte: new Date(query.from), lt: new Date(query.to!) } } : {}),
      ...timestampPage(sortField, direction, this.boundary(cursor, binding)),
    };
    const rows = await this.db.approval.findMany({
      where,
      select: approvalSelect,
      orderBy: [{ [sortField]: direction }, { id: direction }],
      take: query.limit + 1,
    });
    const { page, nextCursor, limit } = this.page(rows, query.limit, binding, sortField);
    return { data: page.map((row) => this.approvalDto(row, asOf)), page: { limit, nextCursor } };
  }

  async getApproval(approvalId: string, asOf = new Date()) {
    const row = await this.db.approval.findUnique({
      where: { id: requireId(approvalId, "approval") },
      select: approvalSelect,
    });
    return row ? this.approvalDto(row, asOf) : null;
  }

  private approvalDto(
    row: Prisma.ApprovalGetPayload<{ select: typeof approvalSelect }>,
    asOf: Date,
  ) {
    if (row.proposal.currency !== "USD")
      throw new DatabaseError("INVALID_CURRENCY", "Only USD approvals are supported.");
    return {
      id: row.id,
      owner: ownerDto(row.user),
      proposalId: row.proposalId,
      decision: row.decision,
      expiresAt: iso(row.expiresAt),
      decidedAt: row.decidedAt ? iso(row.decidedAt) : null,
      effectiveExpired: row.expiresAt <= asOf,
      isSample: row.isSample || row.proposal.isSample,
      proposalStatus: row.proposal.status,
      proposalTotalMinor: minorNumber(row.proposal.total, "proposal total"),
      currency: "USD" as const,
      productTitle: row.proposal.productSnapshot.title,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async listOrders(query: AdminOrderQuery) {
    return this.listPaymentsInternal(query, "orders");
  }
  async getOrder(orderId: string) {
    const row = await this.getPayment(orderId);
    return row?.paypalOrderId ? row : null;
  }
  async listPayments(query: AdminPaymentQuery) {
    return this.listPaymentsInternal(query, "payments");
  }

  private async listPaymentsInternal(
    query: AdminOrderQuery | AdminPaymentQuery,
    resource: "orders" | "payments",
  ) {
    const paymentQuery = query as AdminPaymentQuery;
    const { cursor, ...filters } = paymentQuery;
    const dateBasis = paymentQuery.dateBasis === "captured" ? "capturedAt" : "createdAt";
    const sortField =
      resource === "payments" && (paymentQuery.sort === "capturedAt" || dateBasis === "capturedAt")
        ? "capturedAt"
        : "createdAt";
    const direction = directionOf(paymentQuery.direction);
    const binding = queryBinding({ ...filters, resource });
    const includeSamples = paymentQuery.includeSamples === true;
    const refundState = "refundState" in paymentQuery ? paymentQuery.refundState : undefined;
    const where: Prisma.PaymentWhereInput = {
      ...sampleParent(includeSamples),
      ...(includeSamples ? {} : { proposal: { isSample: false } }),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.proposalId ? { proposalId: query.proposalId } : {}),
      ...("mandateId" in query && query.mandateId ? { mandateId: query.mandateId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...("paypalOrderId" in query && query.paypalOrderId
        ? { paypalOrderId: query.paypalOrderId }
        : resource === "orders"
          ? { paypalOrderId: { not: null } }
          : {}),
      ...("paypalCaptureId" in paymentQuery && paymentQuery.paypalCaptureId
        ? { paypalCaptureId: paymentQuery.paypalCaptureId }
        : {}),
      ...(sortField === "capturedAt" ? { capturedAt: { not: null } } : {}),
      ...(query.from
        ? {
            [dateBasis]: { gte: new Date(query.from), lt: new Date(query.to!) },
          }
        : {}),
      ...(("amountMin" in paymentQuery && paymentQuery.amountMin !== undefined) ||
      ("amountMax" in paymentQuery && paymentQuery.amountMax !== undefined)
        ? {
            amount: {
              ...("amountMin" in paymentQuery && paymentQuery.amountMin !== undefined
                ? { gte: BigInt(paymentQuery.amountMin) }
                : {}),
              ...("amountMax" in paymentQuery && paymentQuery.amountMax !== undefined
                ? { lte: BigInt(paymentQuery.amountMax) }
                : {}),
            },
          }
        : {}),
      ...(refundState === "none" ? { refunds: { none: {} } } : {}),
      ...(refundState === "pending"
        ? { refunds: { some: { status: { in: ["REQUESTED", "APPROVED", "SUBMITTED"] } } } }
        : {}),
      ...(refundState === "refunded" ? { status: { in: ["PARTIALLY_REFUNDED", "REFUNDED"] } } : {}),
      ...timestampPage(sortField, direction, this.boundary(cursor, binding)),
    };
    const rows = await this.db.payment.findMany({
      where,
      select: paymentSelect,
      orderBy: [{ [sortField]: direction }, { id: direction }],
      take: query.limit + 1,
    });
    const { page, nextCursor, limit } = this.page(rows, query.limit, binding, sortField);
    return { data: page.map((row) => this.paymentDto(row)), page: { limit, nextCursor } };
  }

  async getPayment(paymentId: string) {
    const row = await this.db.payment.findUnique({
      where: { id: requireId(paymentId, "payment") },
      select: paymentSelect,
    });
    return row ? this.paymentDto(row) : null;
  }

  private paymentDto(row: Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>) {
    if (row.currency !== "USD")
      throw new DatabaseError("INVALID_CURRENCY", "Only USD payments are supported.");
    const refunded = row.refunds
      .filter((refund) => refund.status === "COMPLETED")
      .reduce((sum, refund) => sum + refund.amount, 0n);
    const held = row.refunds
      .filter((refund) =>
        ["REQUESTED", "APPROVED", "SUBMITTED", "COMPLETED"].includes(refund.status),
      )
      .reduce((sum, refund) => sum + refund.amount, 0n);
    const pending = row.refunds.some((refund) =>
      ["REQUESTED", "APPROVED", "SUBMITTED"].includes(refund.status),
    );
    const remaining = row.amount - held;
    const order = {
      id: row.id,
      paymentId: row.id,
      proposalId: row.proposalId,
      owner: ownerDto(row.user),
      paypalOrderId: row.paypalOrderId,
      amountMinor: minorNumber(row.amount, "payment"),
      currency: "USD" as const,
      paymentStatus: row.status,
      proposalStatus: row.proposal.status,
      providerApprovalKnown: row.status !== "CREATED",
      paypalCaptureId: row.paypalCaptureId,
      capturedAt: row.capturedAt ? iso(row.capturedAt) : null,
      reconciliation: paymentReconciliation({
        status: row.status,
        paypalOrderId: row.paypalOrderId,
        paypalCaptureId: row.paypalCaptureId,
        capturedAt: row.capturedAt ? iso(row.capturedAt) : null,
      }),
      isSample: row.isSample || row.proposal.isSample,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
    return {
      ...order,
      mandateId: row.mandateId,
      failureCode: normalizeFailureCode(row.failureCode),
      refundedMinor: minorNumber(refunded, "refunded"),
      refundCount: row.refunds.length,
      remainingRefundableMinor: minorNumber(remaining < 0n ? 0n : remaining, "remaining"),
      refundState: (["PARTIALLY_REFUNDED", "REFUNDED"].includes(row.status) || refunded > 0n
        ? "refunded"
        : pending
          ? "pending"
          : "none") as "none" | "pending" | "refunded",
      capabilities: paymentCapabilities({
        isSample: order.isSample,
        status: row.status,
        remainingRefundableMinor: minorNumber(remaining < 0n ? 0n : remaining, "remaining"),
        hasPaypalOrderId: Boolean(row.paypalOrderId),
      }),
    };
  }

  async listRefunds(query: AdminRefundQuery) {
    const { cursor, ...filters } = query;
    const binding = queryBinding({ ...filters, resource: "refunds" });
    const direction = directionOf(query.direction);
    const includeSamples = query.includeSamples === true;
    const where: Prisma.RefundWhereInput = {
      ...sampleParent(includeSamples),
      ...(includeSamples ? {} : { payment: { isSample: false, proposal: { isSample: false } } }),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.paymentId ? { paymentId: query.paymentId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.paypalRefundId ? { paypalRefundId: query.paypalRefundId } : {}),
      ...(query.from ? { createdAt: { gte: new Date(query.from), lt: new Date(query.to!) } } : {}),
      ...timestampPage("createdAt", direction, this.boundary(cursor, binding)),
    };
    const rows = await this.db.refund.findMany({
      where,
      select: refundSelect,
      orderBy: [{ createdAt: direction }, { id: direction }],
      take: query.limit + 1,
    });
    const { page, nextCursor, limit } = this.page(rows, query.limit, binding, "createdAt");
    return { data: page.map((row) => this.refundDto(row)), page: { limit, nextCursor } };
  }

  async getRefund(refundId: string) {
    const row = await this.db.refund.findUnique({
      where: { id: requireId(refundId, "refund") },
      select: refundSelect,
    });
    return row ? this.refundDto(row) : null;
  }

  private refundDto(row: Prisma.RefundGetPayload<{ select: typeof refundSelect }>) {
    if (row.currency !== "USD" || row.payment.currency !== "USD")
      throw new DatabaseError("INVALID_CURRENCY", "Only USD refunds are supported.");
    return {
      id: row.id,
      invoiceId: row.id,
      owner: ownerDto(row.user),
      paymentId: row.paymentId,
      amountMinor: minorNumber(row.amount, "refund"),
      currency: "USD" as const,
      status: row.status,
      paypalRefundId: row.paypalRefundId,
      createdAt: iso(row.createdAt),
      settledAt: row.settledAt ? iso(row.settledAt) : null,
      reason: safeAdminText(row.reason),
      failureCode: normalizeFailureCode(row.failureCode),
      kind: row.amount === row.payment.amount ? ("FULL" as const) : ("PARTIAL" as const),
      isSample: row.isSample || row.payment.isSample,
      updatedAt: iso(row.updatedAt),
      capabilities: refundCapabilities({
        isSample: row.isSample || row.payment.isSample,
        status: row.status,
      }),
    };
  }

  async listWebhooks(query: AdminWebhookQuery, asOf = new Date()) {
    const { cursor, ...filters } = query;
    const binding = queryBinding({ ...filters, resource: "webhooks" });
    const direction = directionOf(query.direction);
    const where: Prisma.WebhookInboxWhereInput = {
      ...(query.providerEventId ? { providerEventId: query.providerEventId } : {}),
      ...(query.eventType ? { eventType: query.eventType } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from ? { receivedAt: { gte: new Date(query.from), lt: new Date(query.to!) } } : {}),
      ...(query.retryEligible === true ? recoveryWhere(asOf) : {}),
      ...(query.retryEligible === false ? { NOT: recoveryWhere(asOf) } : {}),
      ...(query.stale === true
        ? {
            signatureVerified: true,
            status: "PROCESSING",
            updatedAt: { lte: new Date(asOf.getTime() - WEBHOOK_LEASE_MS) },
          }
        : {}),
      ...(query.exhausted === true
        ? { signatureVerified: true, status: "FAILED", attempts: { gte: WEBHOOK_MAX_ATTEMPTS } }
        : {}),
      ...timestampPage("receivedAt", direction, this.boundary(cursor, binding)),
    };
    const rows = await this.db.webhookInbox.findMany({
      where,
      select: webhookSelect,
      orderBy: [{ receivedAt: direction }, { id: direction }],
      take: query.limit + 1,
    });
    const { page, nextCursor, limit } = this.page(rows, query.limit, binding, "receivedAt");
    return {
      data: await Promise.all(page.map((row) => this.webhookDto(row, asOf))),
      page: { limit, nextCursor },
    };
  }

  async getWebhook(eventId: string, asOf = new Date()) {
    const row = await this.db.webhookInbox.findUnique({
      where: { id: requireId(eventId, "webhook") },
      select: webhookSelect,
    });
    return row ? this.webhookDto(row, asOf) : null;
  }

  async webhookFinancialLinks(eventId: string, asOf = new Date()) {
    const row = await this.db.webhookInbox.findUnique({
      where: { id: requireId(eventId, "webhook") },
      select: webhookSelect,
    });
    if (!row) return null;
    const links = await this.webhookLinks(row.payload);
    return { webhook: await this.webhookDto(row, asOf), ...links };
  }

  private async webhookLinks(payload: Prisma.JsonValue) {
    const ids = providerIdsFromPayload(payload);
    const paymentIds = new Set<string>();
    const refundIds = new Set<string>();
    for (const id of ids) {
      const [byOrder, byCapture, byRefund] = await Promise.all([
        this.db.payment.findUnique({
          where: { paypalOrderId: id },
          select: { id: true, isSample: true, proposal: { select: { isSample: true } } },
        }),
        this.db.payment.findUnique({
          where: { paypalCaptureId: id },
          select: { id: true, isSample: true, proposal: { select: { isSample: true } } },
        }),
        this.db.refund.findUnique({
          where: { paypalRefundId: id },
          select: {
            id: true,
            isSample: true,
            paymentId: true,
            payment: { select: { isSample: true } },
          },
        }),
      ]);
      const payment = byOrder ?? byCapture;
      if (payment && !payment.isSample && !payment.proposal.isSample) paymentIds.add(payment.id);
      if (byRefund && !byRefund.isSample && !byRefund.payment.isSample) {
        refundIds.add(byRefund.id);
        paymentIds.add(byRefund.paymentId);
      }
    }
    return { paymentIds: [...paymentIds], refundIds: [...refundIds] };
  }

  private async webhookDto(
    row: Prisma.WebhookInboxGetPayload<{ select: typeof webhookSelect }>,
    asOf: Date,
  ) {
    const diagnostics = webhookDiagnostics({ ...row, asOf });
    const links = await this.webhookLinks(row.payload);
    const paymentId = links.paymentIds.length === 1 ? links.paymentIds[0]! : null;
    const refundId = links.refundIds.length === 1 ? links.refundIds[0]! : null;
    return {
      id: row.id,
      providerEventId: row.providerEventId,
      eventType: row.eventType,
      signatureVerified: row.signatureVerified,
      status: row.status,
      attempts: row.attempts,
      receivedAt: iso(row.receivedAt),
      processedAt: row.processedAt ? iso(row.processedAt) : null,
      updatedAt: iso(row.updatedAt),
      nextAttemptAt: row.nextAttemptAt ? iso(row.nextAttemptAt) : null,
      leaseExpiresAt: diagnostics.leaseExpiresAt ? iso(diagnostics.leaseExpiresAt) : null,
      stale: diagnostics.stale,
      retryEligible: diagnostics.retryEligible,
      exhausted: diagnostics.exhausted,
      errorCode: webhookErrorCode(row.lastError, diagnostics.exhausted),
      paymentId,
      orderId: paymentId,
      refundId,
      capabilities: webhookCapabilities({
        retryEligible: diagnostics.retryEligible,
        paymentId,
      }),
    };
  }

  async listDomainAudit(query: AdminDomainAuditQuery) {
    const { cursor, ...filters } = query;
    const binding = queryBinding({ ...filters, resource: "domain-audit" });
    const direction = directionOf(query.direction);
    const includeSamples = query.includeSamples === true;
    const where: Prisma.AuditEventWhereInput = {
      ...sampleParent(includeSamples),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.eventType ? { eventType: query.eventType } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.from ? { createdAt: { gte: new Date(query.from), lt: new Date(query.to!) } } : {}),
      ...timestampPage("createdAt", direction, this.boundary(cursor, binding)),
    };
    const rows = await this.db.auditEvent.findMany({
      where,
      select: {
        id: true,
        userId: true,
        eventType: true,
        entityType: true,
        entityId: true,
        createdAt: true,
        isSample: true,
        payload: true,
      },
      orderBy: [{ createdAt: direction }, { id: direction }],
      take: query.limit + 1,
    });
    const { page, nextCursor, limit } = this.page(rows, query.limit, binding, "createdAt");
    return {
      data: page.map((row) => ({
        id: row.id,
        userId: row.userId,
        eventType: row.eventType,
        entityType: row.entityType,
        entityId: row.entityId,
        createdAt: iso(row.createdAt),
        isSample: row.isSample,
        facts: parseDomainFacts(row.payload),
      })),
      page: { limit, nextCursor },
    };
  }

  async getDomainAudit(eventId: string) {
    const row = await this.db.auditEvent.findUnique({
      where: { id: requireId(eventId, "audit") },
      select: {
        id: true,
        userId: true,
        eventType: true,
        entityType: true,
        entityId: true,
        createdAt: true,
        isSample: true,
        payload: true,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      eventType: row.eventType,
      entityType: row.entityType,
      entityId: row.entityId,
      createdAt: iso(row.createdAt),
      isSample: row.isSample,
      facts: parseDomainFacts(row.payload),
    };
  }

  async overview(
    query: AdminOverviewQuery,
    options: { discoveryMode?: string } = {},
    asOf = new Date(),
  ) {
    const range =
      query.from && query.to
        ? { from: new Date(query.from), to: new Date(query.to) }
        : defaultOverviewRange(asOf);
    const { from, to } = range;
    const inRange = { gte: from, lt: to };
    const nonSamplePayment = { isSample: false, proposal: { isSample: false } };
    const [
      totalUsers,
      verifiedUsers,
      autonomousUsers,
      disabledUsers,
      newUsers,
      activeMandates,
      mandateGroups,
      effectivelyExpired,
      activeProposalCount,
      approvalRequired,
      pendingApprovals,
      overdueApprovals,
      ordersCreated,
      capturedPayments,
      capturedGross,
      paymentFailures,
      refundsCompleted,
      refundsMissingSettlement,
      policyRows,
      webhookGroups,
      recoveryDepth,
      scheduledRetries,
      staleLeases,
      exhausted,
      lastProcessed,
      agentProposals,
      adminActions,
    ] = await Promise.all([
      this.db.user.count(),
      this.db.user.count({ where: { emailVerified: true } }),
      this.db.user.count({ where: { globalAutonomousPurchasingEnabled: true } }),
      this.db.user.count({ where: { disabledAt: { not: null } } }),
      this.db.$queryRaw<Array<{ day: Date; count: bigint }>>(Prisma.sql`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM "User"
        WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        GROUP BY 1
        ORDER BY 1
      `),
      this.db.mandate.count({ where: activeMandateWhere(asOf) }),
      this.db.mandate.groupBy({ by: ["status"], _count: true }),
      this.db.mandate.count({
        where: { expiresAt: { lte: asOf }, status: { in: ["DRAFT", "ACTIVE", "PAUSED"] } },
      }),
      this.db.purchaseProposal.count({
        where: {
          isSample: false,
          status: { in: activeProposals },
          OR: [{ expiresAt: null }, { expiresAt: { gt: asOf } }],
        },
      }),
      this.db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS count
        FROM "PurchaseProposal" p
        JOIN LATERAL (
          SELECT d.decision
          FROM "PolicyDecision" d
          WHERE d."proposalId" = p.id
          ORDER BY d."createdAt" DESC, d.id DESC
          LIMIT 1
        ) latest ON latest.decision = 'REQUIRE_APPROVAL'
        WHERE p."isSample" = false AND p."createdAt" >= ${from} AND p."createdAt" < ${to}
      `),
      this.db.approval.count({
        where: {
          isSample: false,
          decision: "PENDING",
          expiresAt: { gt: asOf },
          proposal: { isSample: false },
        },
      }),
      this.db.approval.count({
        where: {
          isSample: false,
          decision: "PENDING",
          expiresAt: { lte: asOf },
          proposal: { isSample: false },
        },
      }),
      this.db.payment.count({
        where: { ...nonSamplePayment, paypalOrderId: { not: null }, createdAt: inRange },
      }),
      this.db.payment.count({
        where: {
          ...nonSamplePayment,
          status: { in: captured },
          paypalCaptureId: { not: null },
          capturedAt: inRange,
        },
      }),
      this.db.payment.aggregate({
        where: {
          ...nonSamplePayment,
          status: { in: captured },
          paypalCaptureId: { not: null },
          capturedAt: inRange,
        },
        _sum: { amount: true },
      }),
      this.db.payment.count({
        where: { ...nonSamplePayment, status: { in: ["DENIED", "FAILED"] }, createdAt: inRange },
      }),
      this.db.refund.aggregate({
        where: {
          isSample: false,
          status: "COMPLETED",
          settledAt: inRange,
          payment: nonSamplePayment,
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.db.refund.count({
        where: { isSample: false, status: "COMPLETED", settledAt: null, payment: nonSamplePayment },
      }),
      this.db.$queryRaw<Array<{ decision: string; count: bigint }>>(Prisma.sql`
        SELECT latest.decision::text AS decision, COUNT(*)::bigint AS count
        FROM "PurchaseProposal" p
        JOIN LATERAL (
          SELECT d.decision
          FROM "PolicyDecision" d
          WHERE d."proposalId" = p.id
          ORDER BY d."createdAt" DESC, d.id DESC
          LIMIT 1
        ) latest ON true
        WHERE p."isSample" = false AND p."createdAt" >= ${from} AND p."createdAt" < ${to}
        GROUP BY latest.decision
      `),
      this.db.webhookInbox.groupBy({
        by: ["status"],
        where: { signatureVerified: true },
        _count: true,
      }),
      this.db.webhookInbox.count({ where: recoveryWhere(asOf) }),
      this.db.webhookInbox.count({
        where: {
          provider: "paypal",
          signatureVerified: true,
          status: "FAILED",
          attempts: { lt: WEBHOOK_MAX_ATTEMPTS },
          nextAttemptAt: { gt: asOf },
        },
      }),
      this.db.webhookInbox.count({
        where: {
          provider: "paypal",
          signatureVerified: true,
          status: "PROCESSING",
          updatedAt: { lte: new Date(asOf.getTime() - WEBHOOK_LEASE_MS) },
        },
      }),
      this.db.webhookInbox.count({
        where: {
          signatureVerified: true,
          status: "FAILED",
          attempts: { gte: WEBHOOK_MAX_ATTEMPTS },
        },
      }),
      this.db.webhookInbox.aggregate({
        where: { status: "PROCESSED", processedAt: { not: null } },
        _max: { processedAt: true },
      }),
      this.db.auditEvent.count({
        where: {
          eventType: "PRODUCT_SELECTED",
          entityType: "PURCHASE_PROPOSAL",
          isSample: false,
          createdAt: inRange,
          payload: { path: ["aiReason"], equals: "model_selected_server_validated_product" },
        },
      }),
      this.db.adminAuditEvent.count({ where: { createdAt: inRange } }),
    ]);
    const newUserSeries = newUsers.map((row) => ({
      key: iso(row.day).slice(0, 10),
      value: Number(row.count),
    }));
    const refundsByDay = await this.db.$queryRaw<Array<{ day: Date; amount: bigint }>>(Prisma.sql`
      SELECT date_trunc('day', r."settledAt") AS day, SUM(r.amount)::bigint AS amount
      FROM "Refund" r
      JOIN "Payment" p ON p.id = r."paymentId"
      JOIN "PurchaseProposal" pr ON pr.id = p."proposalId"
      WHERE r.status = 'COMPLETED' AND r."isSample" = false AND p."isSample" = false AND pr."isSample" = false
        AND r."settledAt" >= ${from} AND r."settledAt" < ${to}
      GROUP BY 1
      ORDER BY 1
    `);
    const capturedGrossMinor = capturedGross._sum.amount ?? 0n;
    const refundsMinor = refundsCompleted._sum.amount ?? 0n;
    const telemetry = await new ObservabilityRepository(this.db).overviewTelemetry(from, to, asOf);
    const liveness = workerLiveness({
      heartbeatAt: telemetry.worker.row?.heartbeatAt ?? null,
      outcome: telemetry.worker.row?.outcome ?? null,
      now: asOf,
    });
    const warnings = [
      ...(refundsMissingSettlement
        ? ["Completed refunds without settlement timestamps are excluded from dated refund totals."]
        : []),
    ];
    const discovery =
      options.discoveryMode === "demo" || options.discoveryMode === "channel3"
        ? options.discoveryMode
        : null;
    return {
      asOf: iso(asOf),
      range: { from: iso(from), to: iso(to) },
      currency: "USD" as const,
      metrics: {
        totalUsers: metric(
          totalUsers,
          "All user accounts as of the snapshot, including demo accounts.",
        ),
        verifiedUsers: metric(verifiedUsers, "Users with verified email as of the snapshot."),
        autonomousUsers: metric(
          autonomousUsers,
          "Users with global autonomous purchasing enabled as of the snapshot.",
        ),
        newUsersByDay: metric(
          newUserSeries.reduce((sum, row) => sum + row.value, 0),
          "Users created in the selected UTC range.",
          {
            series: newUserSeries,
          },
        ),
        activeMandates: metric(
          activeMandates,
          "Mandates stored ACTIVE whose validity window includes the snapshot time.",
        ),
        mandateStatusDistribution: metric(
          mandateGroups.reduce((sum, row) => sum + row._count, 0),
          "Stored mandate status counts plus a separately labelled effectively-expired count.",
          {
            series: [
              ...mandateGroups.map((row) => ({ key: row.status, value: row._count })),
              { key: "EFFECTIVELY_EXPIRED", value: effectivelyExpired },
            ],
          },
        ),
        activeProposals: metric(
          activeProposalCount,
          "Non-sample proposals in in-flight states whose expiry is null or still in the future.",
        ),
        approvalRequiredProposals: metric(
          approvalRequired[0]?.count ?? 0n,
          "Non-sample proposals created in range whose latest policy decision is REQUIRE_APPROVAL.",
        ),
        pendingApprovals: metric(
          pendingApprovals,
          "Non-sample pending approvals whose deadline is still after the snapshot.",
        ),
        overdueApprovals: metric(
          overdueApprovals,
          "Non-sample pending approvals whose deadline is at or before the snapshot.",
        ),
        ordersCreated: metric(
          ordersCreated,
          "Non-sample payments with a PayPal order ID created in range, labelled by internal creation time.",
        ),
        capturedPayments: metric(
          capturedPayments,
          "Non-sample captured payments (completed or refunded) whose capture time falls in range.",
        ),
        capturedGrossMinor: metric(
          capturedGrossMinor,
          "Original captured amount in range. Refunds do not reduce this gross.",
          {
            unit: "minor",
          },
        ),
        paymentFailures: metric(
          paymentFailures,
          "Non-sample DENIED or FAILED payments created in range. CAPTURE_PENDING is not a failure.",
        ),
        refundsMinor: metric(
          refundsMinor,
          "Completed non-sample refund amounts with settlement time in range.",
          {
            unit: "minor",
          },
        ),
        refundsByDay: metric(
          refundsMinor,
          "Completed refund amounts bucketed by UTC settlement day.",
          {
            unit: "minor",
            series: refundsByDay.map((row) => ({
              key: iso(row.day).slice(0, 10),
              value: minorNumber(row.amount, "refunds"),
            })),
          },
        ),
        netCapturedMinor: {
          value: Number(capturedGrossMinor - refundsMinor),
          availability: "available" as const,
          reason: null,
          definition:
            "Captured gross minus completed refunds for this window. This is cash flow, not restored mandate allowance.",
          unit: "minor" as const,
        },
        policyDistribution: metric(
          policyRows.reduce((sum, row) => sum + Number(row.count), 0),
          "One latest policy decision per non-sample proposal created in range.",
          {
            series: policyRows.map((row) => ({
              key: row.decision,
              value: minorNumber(row.count, "policy"),
            })),
          },
        ),
        webhookFailures: metric(
          webhookGroups.find((row) => row.status === "FAILED")?._count ?? 0,
          "Verified durable inbox rows currently in FAILED status.",
        ),
        webhookStatusCounts: metric(
          webhookGroups.reduce((sum, row) => sum + row._count, 0),
          "Verified durable inbox rows grouped by persisted status.",
          { series: webhookGroups.map((row) => ({ key: row.status, value: row._count })) },
        ),
        recoveryQueueDepth: metric(
          recoveryDepth,
          "Verified PayPal rows eligible now: due FAILED or stale PROCESSING, attempts under five.",
        ),
        scheduledRetries: metric(
          scheduledRetries,
          "Verified FAILED rows with a future retry schedule and attempts under five.",
        ),
        staleLeases: metric(
          staleLeases,
          "Verified PROCESSING rows whose lease is older than five minutes.",
        ),
        exhausted: metric(
          exhausted,
          "Verified FAILED rows that have reached five recovery attempts.",
        ),
        lastWebhookProcessedAt: {
          value: null,
          availability: lastProcessed._max.processedAt
            ? ("available" as const)
            : ("available" as const),
          reason: lastProcessed._max.processedAt
            ? iso(lastProcessed._max.processedAt)
            : "No processed inbox row.",
          definition:
            "Latest processedAt among PROCESSED inbox rows. This is not a worker heartbeat.",
        },
        agentProposalCount: metric(
          agentProposals,
          "PRODUCT_SELECTED audits with model_selected_server_validated_product in range, labelled as recorded agent selections.",
        ),
        agentRequests: metric(
          telemetry.requests,
          "Agent runs started in the selected range. This is recorded operational telemetry, not chat text.",
        ),
        successfulRuns: metric(telemetry.successfulRuns, "Agent runs that completed successfully in range."),
        failedRuns: metric(telemetry.failedRuns, "Agent runs that failed in range."),
        latency: {
          value: telemetry.latencyMs,
          availability: "available" as const,
          reason: telemetry.latencyMs === null ? "No completed runs in range." : "Average duration in milliseconds.",
          definition: "Average recorded agent-run duration in the selected range.",
        },
        toolErrors: metric(telemetry.toolErrors, "Agent tool calls that failed in range."),
        refundDrafts: metric(
          telemetry.refundDrafts,
          "Agent runs that prepared a refund-draft payment identifier in range.",
        ),
        rejectedWebhookDeliveries: metric(
          telemetry.rejected,
          "Webhook delivery attempts rejected before or during verification, in range.",
        ),
        duplicateDeliveries: metric(
          telemetry.duplicate,
          "Repeated webhook deliveries for an event that was already accepted, in range.",
        ),
        lastSuccessfulReconcile: {
          value: null,
          availability: "available" as const,
          reason: telemetry.reconcile
            ? iso(telemetry.reconcile)
            : "No successful admin payment or webhook reconciliation is recorded.",
          definition:
            "Latest successful admin reconciliation audit. This is not a historical provider-health series.",
        },
        disabledUsers: metric(
          disabledUsers,
          "User rows with disabledAt set. As-of count, including test/demo accounts because no User sample marker exists.",
        ),
        adminActions: metric(adminActions, "Admin audit events created in the selected range."),
      },
      controls: {
        discoveryMode: discovery
          ? metric(
              discovery === "demo" ? 1 : 0,
              "Configured product discovery mode only, not a live health probe.",
              {
                reason: discovery,
              },
            )
          : unavailable("Configured product discovery mode.", "Discovery mode is not configured."),
        platformControls: await platformControlMetric(this.db),
        workerLive:
          liveness.status === "unknown"
            ? {
                value: null,
                availability: "available" as const,
                reason: liveness.summary,
                definition: "Webhook worker liveness from the latest heartbeat. Absence is unknown, not healthy.",
              }
            : metric(liveness.status === "ready" ? 1 : 0, "Webhook worker liveness from the latest heartbeat.", {
                reason: liveness.summary,
              }),
        providerHealthHistory: unavailable(
          "Provider health history.",
          "Only the latest bounded probe is available on system health. A historical series is not stored.",
        ),
      },
      warnings,
    };
  }

  async listActivity(query: AdminActivityQuery, asOf = new Date()) {
    const { cursor, ...filters } = query;
    const binding = queryBinding({ ...filters, resource: "activity" });
    const from = query.from ? new Date(query.from) : new Date(asOf.getTime() - 7 * 86400_000);
    const to = query.to ? new Date(query.to) : asOf;
    const highRisk = query.highRisk === true;
    const cutoff = this.boundary(cursor, binding);
    const until = cutoff && cutoff.at < to ? cutoff.at : to;
    const adminWhere: Prisma.AdminAuditEventWhereInput = {
      createdAt: { gte: from, lt: until },
      ...(highRisk ? { action: { in: [...HIGH_RISK_ADMIN_ACTIONS] } } : {}),
    };
    const domainWhere: Prisma.AuditEventWhereInput = {
      createdAt: { gte: from, lt: until },
      isSample: false,
      ...(highRisk ? { eventType: { in: [...HIGH_RISK_DOMAIN_EVENTS] } } : {}),
    };
    const [adminRows, domainRows] = await Promise.all([
      this.db.adminAuditEvent.findMany({
        where: adminWhere,
        select: {
          id: true,
          action: true,
          result: true,
          targetType: true,
          targetId: true,
          actorUserId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      }),
      this.db.auditEvent.findMany({
        where: domainWhere,
        select: {
          id: true,
          eventType: true,
          entityType: true,
          entityId: true,
          userId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      }),
    ]);
    const merged = [
      ...adminRows.map((row) => ({
        id: `admin:${row.id}`,
        source: "admin" as const,
        title: row.action.replaceAll("_", " ").toLowerCase(),
        at: iso(row.createdAt),
        status: row.result,
        highRisk: (HIGH_RISK_ADMIN_ACTIONS as readonly string[]).includes(row.action),
        actorUserId: row.actorUserId,
        targetType: row.targetType,
        targetId: row.targetId,
        href: activityHref(row.targetType, row.targetId),
      })),
      ...domainRows.map((row) => ({
        id: `domain:${row.id}`,
        source: "domain" as const,
        title: row.eventType.replaceAll("_", " ").toLowerCase(),
        at: iso(row.createdAt),
        status: row.eventType,
        highRisk: (HIGH_RISK_DOMAIN_EVENTS as readonly string[]).includes(row.eventType),
        actorUserId: row.userId,
        targetType: row.entityType,
        targetId: row.entityId,
        href: domainHref(row.entityType, row.entityId),
      })),
    ]
      .sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))
      .slice(0, query.limit + 1);
    const page = merged.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page,
      page: {
        limit: query.limit,
        nextCursor:
          merged.length > query.limit && last
            ? encodeCursor(this.secret(), { at: last.at, id: "activity", binding })
            : null,
      },
    };
  }

  async exportUsers(query: AdminUserQuery, asOf = new Date()) {
    return this.collectExport(query, (page) => this.listUsers(page, asOf));
  }
  async exportMandates(query: AdminMandateQuery, asOf = new Date()) {
    return this.collectExport(query, (page) => this.listMandates(page, asOf));
  }
  async exportProposals(query: AdminProposalQuery, asOf = new Date()) {
    return this.collectExport(query, (page) => this.listProposals(page, asOf));
  }
  async exportApprovals(query: AdminApprovalQuery, asOf = new Date()) {
    return this.collectExport(query, (page) => this.listApprovals(page, asOf));
  }
  async exportOrders(query: AdminOrderQuery) {
    return this.collectExport(query, (page) => this.listOrders(page));
  }
  async exportPayments(query: AdminPaymentQuery) {
    return this.collectExport(query, (page) => this.listPayments(page));
  }
  async exportRefunds(query: AdminRefundQuery) {
    return this.collectExport(query, (page) => this.listRefunds(page));
  }
  async exportWebhooks(query: AdminWebhookQuery, asOf = new Date()) {
    return this.collectExport(query, (page) => this.listWebhooks(page, asOf));
  }

  private async collectExport<T, Q extends { limit: number; cursor?: string }>(
    query: Q,
    list: (query: Q) => Promise<{ data: T[]; page: { nextCursor: string | null } }>,
  ) {
    const rows: T[] = [];
    let cursor: string | undefined;
    while (rows.length < ADMIN_CSV_MAX_ROWS) {
      const remaining = ADMIN_CSV_MAX_ROWS - rows.length;
      const result = await list({
        ...query,
        limit: remaining < 100 ? remaining : 100,
        cursor,
      });
      rows.push(...result.data);
      if (!result.page.nextCursor || result.data.length === 0) return { rows, truncated: false };
      cursor = result.page.nextCursor;
      if (rows.length >= ADMIN_CSV_MAX_ROWS) return { rows, truncated: true };
    }
    return { rows, truncated: Boolean(cursor) };
  }
}

function activityHref(targetType: string, targetId: string) {
  const map: Record<
    string,
    "users" | "mandates" | "proposals" | "approvals" | "payments" | "refunds" | "webhooks"
  > = {
    USER: "users",
    MANDATE: "mandates",
    PROPOSAL: "proposals",
    APPROVAL: "approvals",
    PAYMENT: "payments",
    REFUND: "refunds",
    WEBHOOK: "webhooks",
  };
  const resource = map[targetType];
  if (!resource || !AdminResourceIdSchemaSafe(targetId)) return null;
  return { resource, id: targetId };
}

function AdminResourceIdSchemaSafe(id: string) {
  return /^[A-Za-z0-9_-]{1,255}$/u.test(id);
}

function domainHref(entityType: string, entityId: string) {
  const map: Record<
    string,
    "users" | "mandates" | "proposals" | "approvals" | "payments" | "refunds" | "webhooks"
  > = {
    USER: "users",
    MANDATE: "mandates",
    PURCHASE_PROPOSAL: "proposals",
    APPROVAL: "approvals",
    PAYMENT: "payments",
    REFUND: "refunds",
    WEBHOOK_EVENT: "webhooks",
  };
  const resource = map[entityType];
  return resource && AdminResourceIdSchemaSafe(entityId) ? { resource, id: entityId } : null;
}

const mandateSelect = {
  id: true,
  title: true,
  status: true,
  version: true,
  activeVersionId: true,
  currency: true,
  autoSpendLimit: true,
  transactionLimit: true,
  dailyLimit: true,
  weeklyLimit: true,
  monthlyLimit: true,
  spendTimeZone: true,
  startsAt: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: ownerSelect },
  activeVersion: { select: { canonicalRules: true } },
  versions: { select: { canonicalRules: true }, orderBy: { version: "desc" as const }, take: 1 },
  _count: { select: { proposals: true } },
} as const;

const mandateVersionSelect = {
  id: true,
  mandateId: true,
  version: true,
  title: true,
  currency: true,
  autoSpendLimit: true,
  transactionLimit: true,
  dailyLimit: true,
  weeklyLimit: true,
  monthlyLimit: true,
  spendTimeZone: true,
  startsAt: true,
  expiresAt: true,
  canonicalRules: true,
  createdAt: true,
} as const;

const proposalSelect = {
  id: true,
  userId: true,
  mandateId: true,
  mandateVersionId: true,
  quantity: true,
  subtotal: true,
  shipping: true,
  tax: true,
  total: true,
  currency: true,
  status: true,
  expiresAt: true,
  isSample: true,
  createdAt: true,
  updatedAt: true,
  user: { select: ownerSelect },
  productSnapshot: { select: productSelect },
  policyDecisions: {
    orderBy: [
      { createdAt: "desc" },
      { id: "desc" },
    ] satisfies Prisma.PolicyDecisionOrderByWithRelationInput[],
    take: 1,
    select: {
      id: true,
      proposalId: true,
      mandateVersionId: true,
      decision: true,
      reasonCodes: true,
      rulesSnapshot: true,
      spendSnapshot: true,
      createdAt: true,
    },
  },
  approval: { select: { id: true } },
  payment: { select: { id: true } },
  reservation: { select: { id: true } },
};

const approvalSelect = {
  id: true,
  proposalId: true,
  decision: true,
  expiresAt: true,
  decidedAt: true,
  isSample: true,
  createdAt: true,
  updatedAt: true,
  user: { select: ownerSelect },
  proposal: {
    select: {
      status: true,
      total: true,
      currency: true,
      isSample: true,
      productSnapshot: { select: { title: true } },
    },
  },
} as const;

const paymentSelect = {
  id: true,
  userId: true,
  mandateId: true,
  proposalId: true,
  paypalOrderId: true,
  paypalCaptureId: true,
  amount: true,
  currency: true,
  status: true,
  failureCode: true,
  isSample: true,
  capturedAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: ownerSelect },
  proposal: { select: { status: true, isSample: true } },
  refunds: { select: { amount: true, status: true } },
} as const;

const refundSelect = {
  id: true,
  paymentId: true,
  amount: true,
  currency: true,
  status: true,
  paypalRefundId: true,
  reason: true,
  failureCode: true,
  isSample: true,
  settledAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: ownerSelect },
  payment: { select: { amount: true, currency: true, isSample: true } },
} as const;

const webhookSelect = {
  id: true,
  providerEventId: true,
  eventType: true,
  signatureVerified: true,
  status: true,
  attempts: true,
  receivedAt: true,
  processedAt: true,
  updatedAt: true,
  nextAttemptAt: true,
  lastError: true,
  payload: true,
} as const;
