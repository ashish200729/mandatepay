import { evaluateValidatedPolicy, type PolicyContext } from "@mandatepay/agentguard";
import {
  ApprovalDecision,
  AuditEntityType,
  AuditEventType,
  DatabaseError,
  MandateStatus,
  PaymentStatus,
  PolicyDecisionType,
  ProposalStatus,
  ReservationStatus,
  ReservationWindow,
  assertCurrency,
  assertMinorUnits,
  type DatabaseClient,
  type Prisma,
} from "@mandatepay/database";
import { CanonicalMandateSchema, toMinorUnits } from "@mandatepay/shared";
import { proposalFingerprint } from "@mandatepay/database";

type UserOwner = { id: string };
export type TransactionClient = Prisma.TransactionClient;
type LockedProposal = Prisma.PurchaseProposalGetPayload<{
  include: {
    productSnapshot: true;
    mandate: true;
    mandateVersion: true;
    payment: true;
  };
}>;
type ProposalRecordBase = Prisma.PurchaseProposalGetPayload<{
  select: {
    id: true;
    mandateId: true;
    mandateVersionId: true;
    productSnapshotId: true;
    quantity: true;
    subtotal: true;
    shipping: true;
    tax: true;
    total: true;
    currency: true;
    status: true;
    idempotencyKey: true;
    expiresAt: true;
    createdAt: true;
    updatedAt: true;
  };
}>;
type ProposalRecord = ProposalRecordBase & {
  productSnapshot?: {
    title: string;
    brand: string | null;
    condition: string;
    merchant: string;
    source: string;
  };
  mandateVersion?: { id: string; version: number; title: string; expiresAt: Date };
  approval?: { expiresAt: Date; decision: ApprovalDecision } | null;
  policyDecisions?: PolicyRecord[];
};
type PolicyRecord = Prisma.PolicyDecisionGetPayload<{
  select: { id: true; decision: true; reasonCodes: true; createdAt: true };
}>;

const capturedStatuses: PaymentStatus[] = [
  PaymentStatus.COMPLETED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

function utcPeriod(now: Date, window: ReservationWindow) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (window === ReservationWindow.DAILY) {
    return { start: new Date(Date.UTC(y, m, d)), end: new Date(Date.UTC(y, m, d + 1)) };
  }
  if (window === ReservationWindow.WEEKLY) {
    const mondayOffset = now.getUTCDay() === 0 ? -6 : 1 - now.getUTCDay();
    const start = new Date(Date.UTC(y, m, d + mondayOffset));
    return {
      start,
      end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 7)),
    };
  }
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

function sum(values: readonly { amount: bigint }[]) {
  return values.reduce((total, value) => total + value.amount, 0n);
}

function condition(value: string) {
  if (value === "NEW" || value === "USED" || value === "REFURBISHED") return value;
  throw new DatabaseError("INVALID_STATE", "Product condition is not policy-evaluable.");
}

function safeMinor(value: bigint, field: string) {
  assertMinorUnits(value, field);
  return toMinorUnits(Number(value));
}

async function spendContext(
  tx: TransactionClient,
  mandateId: string,
  proposalId: string,
  userId: string,
  merchant: string,
  now: Date,
) {
  const periods = {
    daily: utcPeriod(now, ReservationWindow.DAILY),
    weekly: utcPeriod(now, ReservationWindow.WEEKLY),
    monthly: utcPeriod(now, ReservationWindow.MONTHLY),
  };
  const payments = await tx.payment.findMany({
    where: {
      mandateId,
      status: { in: capturedStatuses },
      capturedAt: { not: null },
    },
    select: { amount: true, currency: true, capturedAt: true },
  });
  const confirmedFor = (window: { start: Date; end: Date }) =>
    sum(
      payments.filter(
        (payment: { capturedAt: Date | null }) =>
          payment.capturedAt !== null &&
          payment.capturedAt >= window.start &&
          payment.capturedAt < window.end,
      ),
    );
  const reservations = await tx.spendReservation.findMany({
    where: { mandateId, proposalId: { not: proposalId }, status: ReservationStatus.ACTIVE },
    select: { id: true, amount: true, currency: true, window: true },
  });
  type PolicyWindow = "DAILY" | "WEEKLY" | "MONTHLY";
  const otherReservations = reservations.map(
    (reservation: { id: string; amount: bigint; currency: string; window: ReservationWindow }) => ({
      id: reservation.id,
      amount: safeMinor(reservation.amount, "reservation amount"),
      currency: "USD" as const,
      windows: (reservation.window === ReservationWindow.TRANSACTION
        ? ["DAILY", "WEEKLY", "MONTHLY"]
        : [reservation.window]) as PolicyWindow[],
    }),
  );
  return {
    currency: "USD" as const,
    confirmed: {
      daily: safeMinor(confirmedFor(periods.daily), "daily confirmed spend"),
      weekly: safeMinor(confirmedFor(periods.weekly), "weekly confirmed spend"),
      monthly: safeMinor(confirmedFor(periods.monthly), "monthly confirmed spend"),
    },
    periods: {
      daily: { startAt: periods.daily.start.toISOString(), endAt: periods.daily.end.toISOString() },
      weekly: {
        startAt: periods.weekly.start.toISOString(),
        endAt: periods.weekly.end.toISOString(),
      },
      monthly: {
        startAt: periods.monthly.start.toISOString(),
        endAt: periods.monthly.end.toISOString(),
      },
    },
    otherReservations,
    isNewMerchant:
      (await tx.payment.count({
        where: {
          userId,
          status: { in: capturedStatuses },
          capturedAt: { not: null },
          proposal: { productSnapshot: { merchant } },
        },
      })) === 0,
  };
}

export function serializeProposal(proposal: ProposalRecord) {
  return {
    id: proposal.id,
    mandateId: proposal.mandateId,
    mandateVersionId: proposal.mandateVersionId,
    productSnapshotId: proposal.productSnapshotId,
    quantity: proposal.quantity,
    subtotal: Number(proposal.subtotal),
    shipping: Number(proposal.shipping),
    tax: Number(proposal.tax),
    total: Number(proposal.total),
    currency: proposal.currency,
    status: proposal.status,
    idempotencyKey: proposal.idempotencyKey,
    product: proposal.productSnapshot
      ? {
          title: proposal.productSnapshot.title,
          brand: proposal.productSnapshot.brand,
          condition: proposal.productSnapshot.condition,
          merchant: proposal.productSnapshot.merchant,
          source: proposal.productSnapshot.source,
        }
      : undefined,
    mandateVersion: proposal.mandateVersion
      ? {
          id: proposal.mandateVersion.id,
          version: proposal.mandateVersion.version,
          title: proposal.mandateVersion.title,
          expiresAt: proposal.mandateVersion.expiresAt.toISOString(),
        }
      : undefined,
    mandate: proposal.mandateVersion
      ? {
          title: proposal.mandateVersion.title,
          version: proposal.mandateVersion.version,
        }
      : undefined,
    expiresAt: proposal.expiresAt ? proposal.expiresAt.toISOString() : null,
    approvalExpiresAt: proposal.approval?.expiresAt.toISOString() ?? null,
    createdAt: proposal.createdAt.toISOString(),
    updatedAt: proposal.updatedAt.toISOString(),
  };
}

function serializeDecision(decision: PolicyRecord) {
  return {
    id: decision.id,
    decision: decision.decision,
    reasonCodes: decision.reasonCodes,
    evaluatedAt: decision.createdAt.toISOString(),
  };
}

async function createReservation(
  tx: TransactionClient,
  proposal: LockedProposal,
  mandate: LockedProposal["mandate"],
  now: Date,
) {
  const existing = await tx.spendReservation.findUnique({ where: { proposalId: proposal.id } });
  if (existing) {
    if (existing.status === ReservationStatus.CONSUMED) return existing;
    if (existing.status !== ReservationStatus.ACTIVE) {
      throw new DatabaseError("INVALID_STATE", "Proposal reservation is no longer active.");
    }
    return existing;
  }
  const expiresAt =
    proposal.expiresAt && proposal.expiresAt < mandate.expiresAt
      ? proposal.expiresAt
      : mandate.expiresAt;
  if (expiresAt <= now) {
    throw new DatabaseError("INVALID_STATE", "Proposal or mandate has expired.");
  }
  return tx.spendReservation.create({
    data: {
      mandateId: mandate.id,
      mandateVersionId: proposal.mandateVersionId,
      proposalId: proposal.id,
      amount: proposal.total,
      currency: proposal.currency,
      window: ReservationWindow.TRANSACTION,
      windowStart: now,
      windowEnd: expiresAt,
      status: ReservationStatus.ACTIVE,
      expiresAt,
    },
  });
}

async function loadLockedContext(
  tx: TransactionClient,
  user: UserOwner,
  proposalId: string,
  now: Date,
) {
  await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', user.id);
  const proposal = await tx.purchaseProposal.findUnique({
    where: { id: proposalId },
    include: { productSnapshot: true, mandate: true, mandateVersion: true, payment: true },
  });
  if (!proposal || proposal.userId !== user.id) {
    throw new DatabaseError("NOT_FOUND", "Proposal was not found for this user.");
  }
  await tx.$queryRawUnsafe('SELECT id FROM "Mandate" WHERE id = $1 FOR UPDATE', proposal.mandateId);
  await tx.$queryRawUnsafe(
    'SELECT id FROM "PurchaseProposal" WHERE id = $1 FOR UPDATE',
    proposal.id,
  );
  const locked = await tx.purchaseProposal.findUnique({
    where: { id: proposal.id },
    include: { productSnapshot: true, mandate: true, mandateVersion: true, payment: true },
  });
  if (!locked || locked.userId !== user.id) {
    throw new DatabaseError("NOT_FOUND", "Proposal was not found for this user.");
  }
  const currencyValues = [
    locked.mandate.currency,
    locked.mandateVersion.currency,
    locked.currency,
    locked.productSnapshot.currency,
  ];
  for (const currency of currencyValues) assertCurrency(currency);
  if (new Set(currencyValues).size !== 1) {
    throw new DatabaseError("INVALID_CURRENCY", "Proposal currency data is inconsistent.");
  }
  const expectedFingerprint = proposalFingerprint({
    userId: locked.userId,
    mandateId: locked.mandateId,
    mandateVersionId: locked.mandateVersionId,
    productSnapshotId: locked.productSnapshotId,
    quantity: locked.quantity,
    subtotal: locked.subtotal,
    shipping: locked.shipping,
    tax: locked.tax,
    total: locked.total,
    currency: locked.currency,
  });
  if (locked.proposalFingerprint !== expectedFingerprint) {
    throw new DatabaseError(
      "CONFLICT",
      "Proposal fingerprint no longer matches its immutable facts.",
    );
  }
  if (locked.expiresAt && now >= locked.expiresAt) {
    throw new DatabaseError("INVALID_STATE", "Proposal has expired.");
  }
  if (
    locked.subtotal !== locked.productSnapshot.price * BigInt(locked.quantity) ||
    locked.total !== locked.subtotal + locked.shipping + locked.tax
  ) {
    throw new DatabaseError("CONFLICT", "Proposal totals no longer match the product snapshot.");
  }
  if (!locked.mandateVersion.canonicalRules) {
    throw new DatabaseError("INVALID_STATE", "Mandate canonical snapshot is invalid.");
  }
  const rules = CanonicalMandateSchema.safeParse(locked.mandateVersion.canonicalRules);
  if (!rules.success) {
    throw new DatabaseError("INVALID_STATE", "Mandate canonical snapshot is invalid.");
  }
  if (locked.mandate.activeVersionId !== locked.mandateVersionId) {
    throw new DatabaseError("CONFLICT", "Proposal is bound to a stale mandate version.");
  }
  if (locked.mandate.status !== MandateStatus.ACTIVE) {
    throw new DatabaseError("INVALID_STATE", "Mandate is not active.");
  }
  if (now < locked.mandate.startsAt || now >= locked.mandate.expiresAt) {
    throw new DatabaseError("INVALID_STATE", "Mandate is outside its validity window.");
  }
  return { proposal: locked, mandate: locked.mandate, rules: rules.data };
}

function policyContext(
  loaded: Awaited<ReturnType<typeof loadLockedContext>>,
  spend: Awaited<ReturnType<typeof spendContext>>,
  user: { id: string; globalAutonomousPurchasingEnabled: boolean },
  now: Date,
): PolicyContext {
  const product = loaded.proposal.productSnapshot;
  const { isNewMerchant, ...spendSnapshot } = spend;
  return {
    now: now.toISOString(),
    mandate: {
      id: loaded.mandate.id,
      version: loaded.proposal.mandateVersion.version,
      status: loaded.mandate.status,
      rules: loaded.rules,
    },
    proposal: {
      mandateId: loaded.proposal.mandateId,
      mandateVersion: loaded.proposal.mandateVersion.version,
      productSnapshotId: loaded.proposal.productSnapshotId,
      quantity: loaded.proposal.quantity,
      subtotal: safeMinor(loaded.proposal.subtotal, "proposal subtotal"),
      shipping: safeMinor(loaded.proposal.shipping, "proposal shipping"),
      tax: safeMinor(loaded.proposal.tax, "proposal tax"),
      total: safeMinor(loaded.proposal.total, "proposal total"),
      currency: "USD",
      idempotencyKey: loaded.proposal.idempotencyKey,
    },
    product: {
      snapshotId: product.id,
      brand: product.brand ?? undefined,
      category: product.category ?? undefined,
      condition: condition(product.condition),
      merchantId: product.merchant,
      merchant: product.merchant,
      isNewMerchant,
      unitPrice: safeMinor(product.price, "product price"),
      currency: "USD",
      quantity: loaded.proposal.quantity,
    },
    spend: spendSnapshot,
    globalAutonomousPurchasingEnabled: user.globalAutonomousPurchasingEnabled,
  };
}

export async function evaluateProposal(
  database: DatabaseClient,
  user: UserOwner,
  proposalId: string,
) {
  return database.$transaction(async (tx) => {
    const now = new Date();
    const loaded = await loadLockedContext(tx, user, proposalId, now);
    const dbUser = await tx.user.findUnique({
      where: { id: user.id },
      select: { id: true, globalAutonomousPurchasingEnabled: true },
    });
    if (!dbUser) throw new DatabaseError("NOT_FOUND", "User was not found.");
    if (
      loaded.proposal.status !== ProposalStatus.PROPOSED &&
      loaded.proposal.status !== ProposalStatus.POLICY_CHECKED &&
      loaded.proposal.status !== ProposalStatus.AWAITING_APPROVAL
    ) {
      throw new DatabaseError(
        "INVALID_STATE",
        "Proposal cannot be evaluated in its current state.",
      );
    }
    const spend = await spendContext(
      tx,
      loaded.mandate.id,
      loaded.proposal.id,
      user.id,
      loaded.proposal.productSnapshot.merchant,
      now,
    );
    const spendSnapshot = {
      ...spend,
      globalAutonomousPurchasingEnabled: dbUser.globalAutonomousPurchasingEnabled,
    };
    const decision = evaluateValidatedPolicy(policyContext(loaded, spend, dbUser, now));
    const nextStatus =
      decision.decision === "ALLOW"
        ? ProposalStatus.AUTHORIZED
        : decision.decision === "REQUIRE_APPROVAL"
          ? ProposalStatus.AWAITING_APPROVAL
          : ProposalStatus.BLOCKED;
    const persistedDecision = await tx.policyDecision.create({
      data: {
        proposalId: loaded.proposal.id,
        mandateVersionId: loaded.proposal.mandateVersionId,
        decision: decision.decision as PolicyDecisionType,
        reasonCodes: decision.reasonCodes,
        rulesSnapshot: loaded.rules,
        spendSnapshot,
      },
    });
    await tx.purchaseProposal.update({
      where: { id: loaded.proposal.id },
      data: { status: nextStatus },
    });
    if (decision.decision === "ALLOW") {
      await createReservation(tx, loaded.proposal, loaded.mandate, now);
    } else if (decision.decision === "REQUIRE_APPROVAL") {
      const existingApproval = await tx.approval.findUnique({
        where: { proposalId: loaded.proposal.id },
      });
      if (existingApproval) {
        if (existingApproval.proposalFingerprint !== loaded.proposal.proposalFingerprint) {
          throw new DatabaseError("CONFLICT", "Approval fingerprint is stale.");
        }
        if (
          existingApproval.decision !== ApprovalDecision.PENDING ||
          existingApproval.expiresAt <= now
        ) {
          throw new DatabaseError("INVALID_STATE", "Approval is no longer available.");
        }
      } else {
        const requestedExpiry = new Date(now.getTime() + 15 * 60_000);
        const deadline = loaded.proposal.expiresAt ?? loaded.mandate.expiresAt;
        const expiresAt = new Date(Math.min(requestedExpiry.getTime(), deadline.getTime()));
        await tx.approval.create({
          data: {
            proposalId: loaded.proposal.id,
            userId: user.id,
            decision: ApprovalDecision.PENDING,
            proposalFingerprint: loaded.proposal.proposalFingerprint,
            expiresAt,
          },
        });
      }
    }
    const eventType =
      decision.decision === "ALLOW"
        ? AuditEventType.POLICY_ALLOWED
        : decision.decision === "REQUIRE_APPROVAL"
          ? AuditEventType.POLICY_APPROVAL_REQUIRED
          : AuditEventType.POLICY_BLOCKED;
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType,
        entityType: AuditEntityType.PURCHASE_PROPOSAL,
        entityId: loaded.proposal.id,
        payload: {
          proposalId: loaded.proposal.id,
          mandateId: loaded.mandate.id,
          mandateVersionId: loaded.proposal.mandateVersionId,
          decision: decision.decision,
          reasonCodes: decision.reasonCodes,
        },
      },
    });
    const updated = await tx.purchaseProposal.findUnique({
      where: { id: loaded.proposal.id },
      include: {
        policyDecisions: { orderBy: { createdAt: "desc" }, take: 1 },
        productSnapshot: true,
        mandateVersion: true,
        approval: true,
      },
    });
    if (!updated) throw new DatabaseError("NOT_FOUND", "Proposal disappeared during evaluation.");
    return {
      proposal: serializeProposal(updated),
      decision: serializeDecision(persistedDecision),
    };
  });
}

export async function approveProposal(
  database: DatabaseClient,
  user: UserOwner,
  proposalId: string,
) {
  return database.$transaction(async (tx) => {
    const now = new Date();
    const loaded = await loadLockedContext(tx, user, proposalId, now);
    const dbUser = await tx.user.findUnique({
      where: { id: user.id },
      select: { id: true, globalAutonomousPurchasingEnabled: true },
    });
    if (!dbUser) throw new DatabaseError("NOT_FOUND", "User was not found.");
    const approval = await tx.approval.findUnique({ where: { proposalId } });
    if (
      loaded.proposal.status === ProposalStatus.AUTHORIZED &&
      approval?.decision === ApprovalDecision.APPROVED &&
      approval.proposalFingerprint === loaded.proposal.proposalFingerprint
    ) {
      const current = await tx.purchaseProposal.findUnique({
        where: { id: proposalId },
        include: { productSnapshot: true, mandateVersion: true, approval: true },
      });
      if (!current) throw new DatabaseError("NOT_FOUND", "Proposal was not found.");
      return { proposal: serializeProposal(current), decision: null, idempotent: true };
    }
    if (loaded.proposal.status !== ProposalStatus.AWAITING_APPROVAL) {
      throw new DatabaseError("INVALID_STATE", "Proposal is not awaiting approval.");
    }
    if (
      !approval ||
      approval.userId !== user.id ||
      approval.decision !== ApprovalDecision.PENDING ||
      approval.proposalFingerprint !== loaded.proposal.proposalFingerprint
    ) {
      throw new DatabaseError("CONFLICT", "Approval is stale or does not belong to this user.");
    }
    if (approval.expiresAt <= now) {
      await tx.approval.update({
        where: { id: approval.id },
        data: { decision: ApprovalDecision.EXPIRED, decidedAt: now },
      });
      await tx.purchaseProposal.update({
        where: { id: proposalId },
        data: { status: ProposalStatus.EXPIRED },
      });
      const expired = await tx.purchaseProposal.findUnique({
        where: { id: proposalId },
        include: { productSnapshot: true, mandateVersion: true, approval: true },
      });
      if (!expired) throw new DatabaseError("NOT_FOUND", "Proposal was not found.");
      return { proposal: serializeProposal(expired), decision: null, expired: true };
    }
    const spend = await spendContext(
      tx,
      loaded.mandate.id,
      loaded.proposal.id,
      user.id,
      loaded.proposal.productSnapshot.merchant,
      now,
    );
    const spendSnapshot = {
      ...spend,
      globalAutonomousPurchasingEnabled: dbUser.globalAutonomousPurchasingEnabled,
    };
    const decision = evaluateValidatedPolicy(policyContext(loaded, spend, dbUser, now));
    const persistedDecision = await tx.policyDecision.create({
      data: {
        proposalId,
        mandateVersionId: loaded.proposal.mandateVersionId,
        decision: decision.decision as PolicyDecisionType,
        reasonCodes: decision.reasonCodes,
        rulesSnapshot: loaded.rules,
        spendSnapshot,
      },
    });
    if (decision.decision === "BLOCK") {
      await tx.approval.update({
        where: { id: approval.id },
        data: { decision: ApprovalDecision.REJECTED, decidedAt: now },
      });
      await tx.purchaseProposal.update({
        where: { id: proposalId },
        data: { status: ProposalStatus.BLOCKED },
      });
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          eventType: AuditEventType.POLICY_BLOCKED,
          entityType: AuditEntityType.PURCHASE_PROPOSAL,
          entityId: proposalId,
          payload: { proposalId, reasonCodes: decision.reasonCodes },
        },
      });
      const blocked = await tx.purchaseProposal.findUnique({
        where: { id: proposalId },
        include: { productSnapshot: true, mandateVersion: true, approval: true },
      });
      if (!blocked) throw new DatabaseError("NOT_FOUND", "Proposal was not found.");
      return {
        proposal: serializeProposal(blocked),
        decision: serializeDecision(persistedDecision),
      };
    }
    await tx.approval.update({
      where: { id: approval.id },
      data: { decision: ApprovalDecision.APPROVED, decidedAt: now },
    });
    await tx.purchaseProposal.update({
      where: { id: proposalId },
      data: { status: ProposalStatus.AUTHORIZED },
    });
    await createReservation(tx, loaded.proposal, loaded.mandate, now);
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.APPROVAL_GRANTED,
        entityType: AuditEntityType.APPROVAL,
        entityId: approval.id,
        payload: { proposalId, mandateId: loaded.mandate.id },
      },
    });
    const updated = await tx.purchaseProposal.findUnique({
      where: { id: proposalId },
      include: { productSnapshot: true, mandateVersion: true, approval: true },
    });
    if (!updated) throw new DatabaseError("NOT_FOUND", "Proposal disappeared during approval.");
    return { proposal: serializeProposal(updated), decision: serializeDecision(persistedDecision) };
  });
}

export async function rejectProposal(
  database: DatabaseClient,
  user: UserOwner,
  proposalId: string,
) {
  return database.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', user.id);
    const proposal = await tx.purchaseProposal.findUnique({ where: { id: proposalId } });
    if (!proposal || proposal.userId !== user.id) {
      throw new DatabaseError("NOT_FOUND", "Proposal was not found for this user.");
    }
    const approval = await tx.approval.findUnique({ where: { proposalId } });
    if (
      proposal.status === ProposalStatus.BLOCKED &&
      approval?.decision === ApprovalDecision.REJECTED &&
      approval.userId === user.id
    ) {
      const current = await tx.purchaseProposal.findUnique({
        where: { id: proposalId },
        include: { productSnapshot: true, mandateVersion: true, approval: true },
      });
      if (!current) throw new DatabaseError("NOT_FOUND", "Proposal was not found.");
      return { proposal: serializeProposal(current), decision: null, idempotent: true };
    }
    if (proposal.status !== ProposalStatus.AWAITING_APPROVAL) {
      throw new DatabaseError("INVALID_STATE", "Proposal is not awaiting approval.");
    }
    if (
      !approval ||
      approval.userId !== user.id ||
      approval.decision !== ApprovalDecision.PENDING
    ) {
      throw new DatabaseError("CONFLICT", "Approval is stale or does not belong to this user.");
    }
    await tx.approval.update({
      where: { id: approval.id },
      data: { decision: ApprovalDecision.REJECTED, decidedAt: new Date() },
    });
    const updated = await tx.purchaseProposal.update({
      where: { id: proposalId },
      data: { status: ProposalStatus.BLOCKED },
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.APPROVAL_REJECTED,
        entityType: AuditEntityType.APPROVAL,
        entityId: approval.id,
        payload: { proposalId, mandateId: proposal.mandateId },
      },
    });
    const result = await tx.purchaseProposal.findUnique({
      where: { id: updated.id },
      include: { productSnapshot: true, mandateVersion: true, approval: true },
    });
    if (!result) throw new DatabaseError("NOT_FOUND", "Proposal was not found.");
    return { proposal: serializeProposal(result), decision: null };
  });
}

export async function getProposal(database: DatabaseClient, user: UserOwner, proposalId: string) {
  const proposal = await database.purchaseProposal.findFirst({
    where: { id: proposalId, userId: user.id },
    include: {
      policyDecisions: { orderBy: { createdAt: "desc" }, take: 1 },
      productSnapshot: true,
      mandateVersion: true,
      approval: true,
    },
  });
  if (!proposal) throw new DatabaseError("NOT_FOUND", "Proposal was not found for this user.");
  return {
    proposal: serializeProposal(proposal),
    decision: proposal.policyDecisions[0] ? serializeDecision(proposal.policyDecisions[0]) : null,
  };
}

export async function listProposals(database: DatabaseClient, user: UserOwner) {
  const proposals = await database.purchaseProposal.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { productSnapshot: true, mandateVersion: true, approval: true },
  });
  return { proposals: proposals.map(serializeProposal) };
}

export async function listApprovals(database: DatabaseClient, user: UserOwner) {
  const approvals = await database.approval.findMany({
    where: { userId: user.id, decision: ApprovalDecision.PENDING },
    orderBy: { expiresAt: "asc" },
    include: {
      proposal: {
        include: {
          productSnapshot: true,
          mandateVersion: true,
        },
      },
    },
  });
  return {
    proposals: approvals.map((approval) => serializeProposal({ ...approval.proposal, approval })),
  };
}

export interface AuthoritativeProductCheck {
  price: bigint;
  currency: string;
}

export interface RevalidateAuthorizationOptions {
  /**
   * Payment claiming uses the same authorization transaction as reservation
   * creation. The default only accepts an AUTHORIZED proposal; a capture may
   * additionally re-check an order that is already at the provider boundary.
   */
  readonly allowedProposalStatuses?: readonly ProposalStatus[];
}

export async function revalidateAuthorizationInTransaction(
  tx: TransactionClient,
  user: UserOwner,
  proposalId: string,
  authoritativeProduct?: AuthoritativeProductCheck,
  options: RevalidateAuthorizationOptions = {},
) {
  const now = new Date();
  const loaded = await loadLockedContext(tx, user, proposalId, now);
  const allowedStatuses = options.allowedProposalStatuses ?? [ProposalStatus.AUTHORIZED];
  if (!allowedStatuses.includes(loaded.proposal.status)) {
    throw new DatabaseError("INVALID_STATE", "Proposal is not ready for authorization.");
  }
  if (authoritativeProduct) {
    assertCurrency(authoritativeProduct.currency);
    if (
      authoritativeProduct.currency !== loaded.proposal.currency ||
      authoritativeProduct.price !== loaded.proposal.productSnapshot.price
    ) {
      throw new DatabaseError("CONFLICT", "Authoritative product price or currency changed.");
    }
  }

  // The user row is locked by loadLockedContext before this read. This keeps
  // the global autonomy kill switch in the same serialization boundary as the
  // policy decision and the spend reservation.
  const dbUser = await tx.user.findUnique({
    where: { id: user.id },
    select: { id: true, globalAutonomousPurchasingEnabled: true },
  });
  if (!dbUser) throw new DatabaseError("NOT_FOUND", "User was not found.");
  const spend = await spendContext(
    tx,
    loaded.mandate.id,
    loaded.proposal.id,
    user.id,
    loaded.proposal.productSnapshot.merchant,
    now,
  );
  const spendSnapshot = {
    ...spend,
    globalAutonomousPurchasingEnabled: dbUser.globalAutonomousPurchasingEnabled,
  };
  const decision = evaluateValidatedPolicy(policyContext(loaded, spend, dbUser, now));
  const persistedDecision = await tx.policyDecision.create({
    data: {
      proposalId,
      mandateVersionId: loaded.proposal.mandateVersionId,
      decision: decision.decision as PolicyDecisionType,
      reasonCodes: decision.reasonCodes,
      rulesSnapshot: loaded.rules,
      spendSnapshot,
    },
  });

  if (decision.decision === "BLOCK") {
    if (loaded.proposal.status !== ProposalStatus.PAYPAL_ORDER_CREATED) {
      await tx.purchaseProposal.update({
        where: { id: proposalId },
        data: { status: ProposalStatus.BLOCKED },
      });
    }
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.POLICY_BLOCKED,
        entityType: AuditEntityType.PURCHASE_PROPOSAL,
        entityId: proposalId,
        payload: { proposalId, reasonCodes: decision.reasonCodes },
      },
    });
    return {
      authorized: false,
      decision: serializeDecision(persistedDecision),
      proposal: loaded.proposal,
      reservation: null,
    };
  }

  let approvalIsValid = false;
  if (decision.decision === "REQUIRE_APPROVAL") {
    const approval = await tx.approval.findUnique({ where: { proposalId } });
    approvalIsValid = Boolean(
      approval &&
      approval.userId === user.id &&
      approval.decision === ApprovalDecision.APPROVED &&
      approval.proposalFingerprint === loaded.proposal.proposalFingerprint &&
      approval.expiresAt > now,
    );

    if (!approvalIsValid) {
      const deadline = loaded.proposal.expiresAt ?? loaded.mandate.expiresAt;
      const expiresAt = new Date(Math.min(now.getTime() + 15 * 60_000, deadline.getTime()));
      if (expiresAt <= now) {
        throw new DatabaseError("INVALID_STATE", "Approval window has expired.");
      }
      if (approval) {
        await tx.approval.update({
          where: { id: approval.id },
          data: {
            userId: user.id,
            decision: ApprovalDecision.PENDING,
            proposalFingerprint: loaded.proposal.proposalFingerprint,
            expiresAt,
            decidedAt: null,
          },
        });
      } else {
        await tx.approval.create({
          data: {
            proposalId,
            userId: user.id,
            decision: ApprovalDecision.PENDING,
            proposalFingerprint: loaded.proposal.proposalFingerprint,
            expiresAt,
          },
        });
      }
      if (
        loaded.proposal.status === ProposalStatus.AUTHORIZED ||
        loaded.proposal.status === ProposalStatus.PAYPAL_ORDER_CREATED
      ) {
        await tx.purchaseProposal.update({
          where: { id: proposalId },
          data: { status: ProposalStatus.AWAITING_APPROVAL },
        });
      }
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          eventType: AuditEventType.POLICY_APPROVAL_REQUIRED,
          entityType: AuditEntityType.PURCHASE_PROPOSAL,
          entityId: proposalId,
          payload: { proposalId, reasonCodes: decision.reasonCodes },
        },
      });
      return {
        authorized: false,
        decision: serializeDecision(persistedDecision),
        proposal: loaded.proposal,
        reservation: null,
      };
    }
  }

  const reservation = await createReservation(tx, loaded.proposal, loaded.mandate, now);
  return {
    authorized: decision.decision === "ALLOW" || approvalIsValid,
    decision: serializeDecision(persistedDecision),
    proposal: loaded.proposal,
    reservation,
  };
}

export async function revalidateAuthorization(
  database: DatabaseClient,
  user: UserOwner,
  proposalId: string,
  authoritativeProduct?: AuthoritativeProductCheck,
  options: RevalidateAuthorizationOptions = {},
) {
  return database.$transaction((tx) =>
    revalidateAuthorizationInTransaction(tx, user, proposalId, authoritativeProduct, options),
  );
}
