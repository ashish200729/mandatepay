import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { buildAdminSummary, AdminTraceIdSchema } from "@mandatepay/shared";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { getPrismaClient } from "../client.js";
import { DatabaseError } from "../errors.js";
import {
  AdminAuditRepository,
  normalizeAdminAuditInput,
  type AppendAdminAuditEventInput,
  type AdminAuditActor,
} from "./admin-audit-repository.js";

type ClaimInput = Omit<
  AppendAdminAuditEventInput,
  "actor" | "actionId" | "result" | "errorCode" | "afterSummaryJson"
> & {
  actor: AdminAuditActor;
  requestKey: string;
  requestSummaryJson?: unknown;
};
type OutcomeInput = {
  actor: AdminAuditActor;
  requestId: string;
  correlationId: string;
  result: "SUCCESS" | "FAILURE" | "PENDING";
  afterSummaryJson?: unknown;
  errorCode?: AppendAdminAuditEventInput["errorCode"];
};
function canonical(value: unknown): string {
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

/** Durable intent/outcome identity only; never executes or authorizes a domain action. */
export class AdminActionRepository {
  constructor(private readonly db: PrismaClient = getPrismaClient()) {}
  claim(input: ClaimInput) {
    return this.db.$transaction((tx) => this.claimInTransaction(tx, input));
  }
  async claimInTransaction(tx: Prisma.TransactionClient, input: ClaimInput) {
    const { requestKey, requestSummaryJson, ...eventInput } = input;
    if (!AdminTraceIdSchema.safeParse(requestKey).success)
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "A UUID request key is required.");
    const event = normalizeAdminAuditInput({ ...eventInput, result: "PENDING" });
    if (
      event.action.startsWith("ADMIN_LOGIN") ||
      event.action.startsWith("ADMIN_REAUTH") ||
      event.action === "ADMIN_LOGOUT_SUCCEEDED"
    )
      throw new DatabaseError(
        "INVALID_DOMAIN_INPUT",
        "Session events cannot claim operational actions.",
      );
    let requestSummary;
    try {
      requestSummary = buildAdminSummary(event.targetType, requestSummaryJson);
    } catch {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "Invalid action summary.");
    }
    const fingerprint = createHash("sha256")
      .update(
        canonical({
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          reason: event.reason,
          before: event.beforeSummaryJson,
          requested: requestSummary,
        }),
      )
      .digest("hex");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.actor.principalId + ":" + requestKey}))`;
    const principal = await tx.adminPrincipal.findUnique({
      where: { id: input.actor.principalId },
      include: { user: { select: { emailVerified: true } } },
    });
    if (
      !principal?.active ||
      !principal.user.emailVerified ||
      principal.userId !== input.actor.userId ||
      principal.role !== input.actor.role
    )
      throw new DatabaseError("OWNERSHIP_REQUIRED", "Active administrator required.");
    const existing = await tx.adminActionRequest.findUnique({
      where: { principalId_requestKey: { principalId: principal.id, requestKey } },
    });
    if (existing) {
      if (existing.requestFingerprint !== fingerprint)
        throw new DatabaseError("CONFLICT", "Action key was reused with different input.");
      return { actionId: existing.id, status: existing.status, created: false };
    }
    const actionId = randomUUID();
    const row = await tx.adminActionRequest.create({
      data: {
        id: actionId,
        principalId: principal.id,
        actorUserId: principal.userId,
        requestKey,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        reason: event.reason,
        requestFingerprint: fingerprint,
        requestSummaryJson: requestSummary ?? Prisma.DbNull,
      },
    });
    await new AdminAuditRepository(tx).append({
      ...eventInput,
      actionId,
      result: "PENDING",
      afterSummaryJson: null,
    });
    return { actionId: row.id, status: row.status, created: true };
  }
  recordOutcome(actionId: string, input: OutcomeInput) {
    return this.db.$transaction((tx) => this.recordOutcomeInTransaction(tx, actionId, input));
  }
  async recordOutcomeInTransaction(
    tx: Prisma.TransactionClient,
    actionId: string,
    input: OutcomeInput,
  ) {
    if (!z.uuid().safeParse(actionId).success)
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "Invalid action ID.");
    await tx.$queryRaw`SELECT id FROM "AdminActionRequest" WHERE id = ${actionId} FOR UPDATE`;
    const action = await tx.adminActionRequest.findUnique({ where: { id: actionId } });
    if (!action) throw new DatabaseError("NOT_FOUND", "Action not found.");
    if (
      action.principalId !== input.actor.principalId ||
      action.actorUserId !== input.actor.userId ||
      input.actor.role !== "ADMIN_SUPER"
    )
      throw new DatabaseError("OWNERSHIP_REQUIRED", "Action belongs to another administrator.");
    const intent = await tx.adminAuditEvent.findFirst({
      where: { actionId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { correlationId: true },
    });
    if (!intent) throw new DatabaseError("INVALID_STATE", "Action intent audit is missing.");
    if (intent.correlationId !== input.correlationId)
      throw new DatabaseError("CONFLICT", "Action correlation cannot change.");
    const event = normalizeAdminAuditInput({
      ...input,
      actionId,
      action: action.action,
      targetType: action.targetType,
      targetId: action.targetId,
      reason: action.reason,
    });
    const status =
      event.result === "SUCCESS" ? "COMPLETED" : event.result === "FAILURE" ? "FAILED" : "PENDING";
    if (action.status !== "PENDING") {
      if (
        action.status !== status ||
        action.errorCode !== (event.errorCode ?? null) ||
        canonical(action.resultSummaryJson) !== canonical(event.afterSummaryJson)
      )
        throw new DatabaseError("CONFLICT", "The action already has a different outcome.");
      return { actionId, status: action.status, changed: false };
    }
    await tx.adminActionRequest.update({
      where: { id: actionId },
      data: {
        status,
        resultSummaryJson: event.afterSummaryJson ?? Prisma.DbNull,
        errorCode: event.errorCode ?? null,
      },
    });
    await new AdminAuditRepository(tx).append({
      ...input,
      actionId,
      action: action.action,
      targetType: action.targetType,
      targetId: action.targetId,
      reason: action.reason,
    });
    return { actionId, status, changed: true };
  }
}
