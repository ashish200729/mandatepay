import type { PrismaClient } from "../generated/prisma/client.js";
import {
  ApprovalDecision,
  MandateStatus,
  PolicyDecisionType,
  ProposalStatus,
} from "../generated/prisma/enums.js";
import { getPrismaClient } from "../client.js";
import { DatabaseError } from "../errors.js";
import { proposalFingerprint } from "../fingerprint.js";
import {
  assertCurrency,
  assertDateRange,
  assertMinorUnits,
  assertQuantity,
  sumMinorUnits,
  SUPPORTED_CURRENCY,
} from "../money.js";

export interface CreateProposalInput {
  userId: string;
  mandateId: string;
  mandateVersionId: string;
  productSnapshotId: string;
  quantity: number;
  shipping: bigint;
  tax: bigint;
  idempotencyKey: string;
  expiresAt?: Date | null;
}

export interface RecordPolicyDecisionInput {
  proposalId: string;
  userId: string;
  decision: PolicyDecisionType;
  reasonCodes: unknown;
  rulesSnapshot: unknown;
  spendSnapshot: unknown;
}

const proposalInclude = {
  productSnapshot: true,
  mandate: { include: { activeVersion: { include: { rules: true } } } },
  mandateVersion: { include: { rules: true } },
  policyDecisions: { orderBy: { createdAt: "desc" as const } },
  approval: true,
  payment: true,
  reservation: true,
} as const;

const transitions: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  DRAFT: [ProposalStatus.PROPOSED, ProposalStatus.CANCELLED, ProposalStatus.EXPIRED],
  PROPOSED: [
    ProposalStatus.POLICY_CHECKED,
    ProposalStatus.BLOCKED,
    ProposalStatus.AWAITING_APPROVAL,
    ProposalStatus.AUTHORIZED,
    ProposalStatus.CANCELLED,
    ProposalStatus.EXPIRED,
  ],
  POLICY_CHECKED: [
    ProposalStatus.BLOCKED,
    ProposalStatus.AWAITING_APPROVAL,
    ProposalStatus.AUTHORIZED,
    ProposalStatus.CANCELLED,
    ProposalStatus.EXPIRED,
  ],
  BLOCKED: [],
  AWAITING_APPROVAL: [ProposalStatus.APPROVED, ProposalStatus.BLOCKED, ProposalStatus.EXPIRED],
  APPROVED: [ProposalStatus.AUTHORIZED, ProposalStatus.BLOCKED, ProposalStatus.EXPIRED],
  AUTHORIZED: [
    ProposalStatus.AWAITING_APPROVAL,
    ProposalStatus.PAYPAL_ORDER_CREATED,
    ProposalStatus.FAILED,
    ProposalStatus.CANCELLED,
  ],
  PAYPAL_ORDER_CREATED: [
    ProposalStatus.AWAITING_APPROVAL,
    ProposalStatus.PAYMENT_PENDING,
    ProposalStatus.FAILED,
    ProposalStatus.CANCELLED,
  ],
  PAYMENT_PENDING: [ProposalStatus.COMPLETED, ProposalStatus.FAILED],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

function assertJsonValue(value: unknown, field: string): void {
  if (value === undefined || typeof value === "bigint" || typeof value === "function") {
    throw new DatabaseError("INVALID_DOMAIN_INPUT", `${field} must be JSON serializable.`);
  }
  try {
    JSON.stringify(value);
  } catch {
    throw new DatabaseError("INVALID_DOMAIN_INPUT", `${field} must be JSON serializable.`);
  }
}

export class ProposalRepository {
  constructor(private readonly db: PrismaClient = getPrismaClient()) {}

  async create(input: CreateProposalInput) {
    assertQuantity(input.quantity);
    assertMinorUnits(input.shipping, "shipping");
    assertMinorUnits(input.tax, "tax");
    if (!input.idempotencyKey.trim()) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "idempotencyKey is required.");
    }

    if (input.expiresAt) {
      assertDateRange(new Date(), input.expiresAt, "proposal expiry");
    }

    return this.db.$transaction(async (tx) => {
      const existing = await tx.purchaseProposal.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: proposalInclude,
      });
      if (existing) {
        if (existing.userId !== input.userId) {
          throw new DatabaseError(
            "OWNERSHIP_REQUIRED",
            "The proposal idempotency key belongs to another user.",
          );
        }
        const product = await tx.productSnapshot.findUnique({
          where: { id: input.productSnapshotId },
        });
        if (!product) {
          throw new DatabaseError("NOT_FOUND", "Product snapshot was not found.");
        }
        const expectedSubtotal = product.price * BigInt(input.quantity);
        const expectedTotal = sumMinorUnits(expectedSubtotal, input.shipping, input.tax);
        const expectedFingerprint = proposalFingerprint({
          userId: input.userId,
          mandateId: input.mandateId,
          mandateVersionId: input.mandateVersionId,
          productSnapshotId: input.productSnapshotId,
          quantity: input.quantity,
          subtotal: expectedSubtotal,
          shipping: input.shipping,
          tax: input.tax,
          total: expectedTotal,
          currency: product.currency,
        });
        if (existing.proposalFingerprint !== expectedFingerprint) {
          throw new DatabaseError(
            "CONFLICT",
            "The idempotency key was reused with different proposal data.",
          );
        }
        return existing;
      }

      const [mandate, version, product] = await Promise.all([
        tx.mandate.findFirst({ where: { id: input.mandateId, userId: input.userId } }),
        tx.mandateVersion.findFirst({
          where: { id: input.mandateVersionId, mandateId: input.mandateId },
        }),
        tx.productSnapshot.findUnique({ where: { id: input.productSnapshotId } }),
      ]);

      if (!mandate || !version || !product) {
        throw new DatabaseError(
          "NOT_FOUND",
          "Mandate, version, or product snapshot was not found.",
        );
      }
      if (mandate.status !== MandateStatus.ACTIVE) {
        throw new DatabaseError(
          "INVALID_STATE",
          "Only an active mandate can create a purchase proposal.",
        );
      }

      const now = new Date();
      if (now < version.startsAt || now >= version.expiresAt) {
        throw new DatabaseError(
          "INVALID_STATE",
          "The selected mandate version is not currently valid.",
        );
      }
      if (mandate.activeVersionId !== version.id) {
        throw new DatabaseError(
          "CONFLICT",
          "The proposal must bind to the mandate's active version.",
        );
      }

      assertCurrency(mandate.currency);
      assertCurrency(version.currency);
      assertCurrency(product.currency);
      if (mandate.currency !== version.currency || version.currency !== product.currency) {
        throw new DatabaseError(
          "INVALID_CURRENCY",
          "Mandate, version, and product currencies must match.",
        );
      }

      const subtotal = product.price * BigInt(input.quantity);
      assertMinorUnits(subtotal, "subtotal");
      const total = sumMinorUnits(subtotal, input.shipping, input.tax);
      const fingerprint = proposalFingerprint({
        userId: input.userId,
        mandateId: input.mandateId,
        mandateVersionId: input.mandateVersionId,
        productSnapshotId: input.productSnapshotId,
        quantity: input.quantity,
        subtotal,
        shipping: input.shipping,
        tax: input.tax,
        total,
        currency: SUPPORTED_CURRENCY,
      });

      const proposal = await tx.purchaseProposal.create({
        data: {
          userId: input.userId,
          mandateId: input.mandateId,
          mandateVersionId: input.mandateVersionId,
          productSnapshotId: input.productSnapshotId,
          quantity: input.quantity,
          subtotal,
          shipping: input.shipping,
          tax: input.tax,
          total,
          currency: SUPPORTED_CURRENCY,
          status: ProposalStatus.PROPOSED,
          proposalFingerprint: fingerprint,
          idempotencyKey: input.idempotencyKey,
          expiresAt: input.expiresAt ?? null,
        },
        include: proposalInclude,
      });

      return proposal;
    });
  }

  async getByIdForUser(proposalId: string, userId: string) {
    const proposal = await this.db.purchaseProposal.findFirst({
      where: { id: proposalId, userId },
      include: proposalInclude,
    });
    if (!proposal) {
      throw new DatabaseError("NOT_FOUND", "Purchase proposal was not found for this user.");
    }
    return proposal;
  }

  listForUser(userId: string, take = 50) {
    return this.db.purchaseProposal.findMany({
      where: { userId },
      include: proposalInclude,
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(take, 1), 100),
    });
  }

  async recordPolicyDecision(input: RecordPolicyDecisionInput) {
    assertJsonValue(input.reasonCodes, "reasonCodes");
    assertJsonValue(input.rulesSnapshot, "rulesSnapshot");
    assertJsonValue(input.spendSnapshot, "spendSnapshot");

    return this.db.$transaction(async (tx) => {
      const proposal = await tx.purchaseProposal.findFirst({
        where: { id: input.proposalId, userId: input.userId },
      });
      if (!proposal) {
        throw new DatabaseError("NOT_FOUND", "Purchase proposal was not found for this user.");
      }
      const next =
        input.decision === PolicyDecisionType.ALLOW
          ? ProposalStatus.AUTHORIZED
          : input.decision === PolicyDecisionType.REQUIRE_APPROVAL
            ? ProposalStatus.AWAITING_APPROVAL
            : ProposalStatus.BLOCKED;
      assertTransition(proposal.status, next);

      const decision = await tx.policyDecision.create({
        data: {
          proposalId: proposal.id,
          mandateVersionId: proposal.mandateVersionId,
          decision: input.decision,
          reasonCodes: input.reasonCodes as object,
          rulesSnapshot: input.rulesSnapshot as object,
          spendSnapshot: input.spendSnapshot as object,
        },
      });
      await tx.purchaseProposal.update({ where: { id: proposal.id }, data: { status: next } });
      return decision;
    });
  }

  async requestApproval(proposalId: string, userId: string, expiresAt: Date) {
    assertDateRange(new Date(), expiresAt, "approval expiry");
    return this.db.$transaction(async (tx) => {
      const proposal = await tx.purchaseProposal.findFirst({ where: { id: proposalId, userId } });
      if (!proposal) {
        throw new DatabaseError("NOT_FOUND", "Purchase proposal was not found for this user.");
      }
      if (proposal.status !== ProposalStatus.AWAITING_APPROVAL) {
        throw new DatabaseError(
          "INVALID_STATE",
          "Only a proposal awaiting approval can be submitted for approval.",
        );
      }
      return tx.approval.upsert({
        where: { proposalId },
        create: {
          proposalId,
          userId,
          decision: ApprovalDecision.PENDING,
          proposalFingerprint: proposal.proposalFingerprint,
          expiresAt,
        },
        update: {
          userId,
          decision: ApprovalDecision.PENDING,
          proposalFingerprint: proposal.proposalFingerprint,
          expiresAt,
          decidedAt: null,
        },
      });
    });
  }

  async grantApproval(proposalId: string, userId: string) {
    return this.decideApproval(proposalId, userId, ApprovalDecision.APPROVED);
  }

  async rejectApproval(proposalId: string, userId: string) {
    return this.decideApproval(proposalId, userId, ApprovalDecision.REJECTED);
  }

  private async decideApproval(proposalId: string, userId: string, decision: ApprovalDecision) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PurchaseProposal" WHERE id = ${proposalId} FOR UPDATE`;
      const proposal = await tx.purchaseProposal.findFirst({
        where: { id: proposalId, userId },
        include: { approval: true },
      });
      if (!proposal || !proposal.approval) {
        throw new DatabaseError("NOT_FOUND", "Approval was not found for this user.");
      }
      if (proposal.approval.proposalFingerprint !== proposal.proposalFingerprint) {
        throw new DatabaseError(
          "CONFLICT",
          "Approval no longer matches the immutable proposal fingerprint.",
        );
      }
      if (proposal.approval.expiresAt <= new Date()) {
        await tx.approval.update({
          where: { id: proposal.approval.id },
          data: { decision: ApprovalDecision.EXPIRED, decidedAt: new Date() },
        });
        if (proposal.status === ProposalStatus.AWAITING_APPROVAL) {
          await tx.purchaseProposal.update({
            where: { id: proposal.id },
            data: { status: ProposalStatus.EXPIRED },
          });
        }
        throw new DatabaseError("INVALID_STATE", "Approval has expired.");
      }
      if (proposal.status !== ProposalStatus.AWAITING_APPROVAL) {
        if (
          decision === ApprovalDecision.APPROVED &&
          proposal.status === ProposalStatus.APPROVED &&
          proposal.approval.decision === ApprovalDecision.APPROVED
        ) {
          return proposal.approval;
        }
        throw new DatabaseError("INVALID_STATE", `Proposal is already ${proposal.status}.`);
      }

      const approval = await tx.approval.update({
        where: { id: proposal.approval.id },
        data: { decision, decidedAt: new Date() },
      });
      await tx.purchaseProposal.update({
        where: { id: proposal.id },
        data: {
          status:
            decision === ApprovalDecision.APPROVED
              ? ProposalStatus.APPROVED
              : ProposalStatus.BLOCKED,
        },
      });
      return approval;
    });
  }

  async transition(proposalId: string, userId: string, next: ProposalStatus) {
    return this.db.$transaction(async (tx) => {
      const proposal = await tx.purchaseProposal.findFirst({ where: { id: proposalId, userId } });
      if (!proposal) {
        throw new DatabaseError("NOT_FOUND", "Purchase proposal was not found for this user.");
      }
      assertTransition(proposal.status, next);
      return tx.purchaseProposal.update({
        where: { id: proposal.id },
        data: { status: next },
        include: proposalInclude,
      });
    });
  }
}

function assertTransition(current: ProposalStatus, next: ProposalStatus): void {
  if (!(transitions[current] ?? []).includes(next)) {
    throw new DatabaseError("INVALID_STATE", `Cannot move proposal from ${current} to ${next}.`);
  }
}
