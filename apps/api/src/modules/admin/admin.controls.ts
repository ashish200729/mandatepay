import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AdminActionRepository,
  AdminOperationsRepository,
  isDatabaseError,
  MandateRepository,
  Prisma,
  type DatabaseClient,
} from "@mandatepay/database";
import {
  AdminMandateLifecycleMutationSchema,
  AdminNoteCreateSchema,
  AdminNoteQuerySchema,
  AdminProposalReevaluateMutationSchema,
  AdminResourceIdSchema,
  AdminUserAccessMutationSchema,
  AdminUserDisableMutationSchema,
  type AdminAuditAction,
} from "@mandatepay/shared";
import { evaluateProposalInTransaction } from "../../services/proposals.js";
import { AdminAuthError, requireFreshAdminAuth, type AdminIdentity } from "./admin.auth.js";
import type { AuthRuntime } from "../../auth.js";

const idParam = z.object({ id: AdminResourceIdSchema }).strict();

export class AdminControlError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Actor = { principalId: string; userId: string; role: "ADMIN_SUPER" };
type Trace = { requestId: string; correlationId: string };

function controlError(error: unknown): never {
  if (error instanceof AdminControlError) throw error;
  if (isDatabaseError(error)) {
    if (error.code === "NOT_FOUND")
      throw new AdminControlError(
        "ADMIN_TARGET_NOT_FOUND",
        404,
        "The requested record was not found.",
      );
    if (error.code === "CONFLICT")
      throw new AdminControlError(
        "CONFLICT",
        409,
        "The record changed. Reload its current state before trying again.",
      );
    if (error.code === "INVALID_STATE")
      throw new AdminControlError(
        "INVALID_STATE",
        409,
        "The record is not in a valid state for this action.",
      );
    if (error.code === "INVALID_DOMAIN_INPUT")
      throw new AdminControlError(
        "ADMIN_INVALID_REQUEST",
        400,
        "Check the action details and try again.",
      );
    if (error.code === "OWNERSHIP_REQUIRED")
      throw new AdminControlError("ADMIN_FORBIDDEN", 403, "This action is not permitted.");
  }
  throw error;
}

function noteHash(body: string) {
  return createHash("sha256").update(body).digest("hex");
}

async function lockedUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  const user = await tx.user.findUnique({
    where: { id: userId },
    include: { adminPrincipal: { select: { id: true, active: true } } },
  });
  if (!user)
    throw new AdminControlError(
      "ADMIN_TARGET_NOT_FOUND",
      404,
      "The requested record was not found.",
    );
  return user;
}

function assertExpectedUser(
  user: { updatedAt: Date; accessVersion: number },
  expectedUpdatedAt: string,
  expectedAccessVersion: number,
) {
  if (
    user.updatedAt.toISOString() !== expectedUpdatedAt ||
    user.accessVersion !== expectedAccessVersion
  ) {
    throw new AdminControlError(
      "CONFLICT",
      409,
      "The record changed. Reload its current state before trying again.",
    );
  }
}

async function claimAndReuse(options: {
  tx: Prisma.TransactionClient;
  db: DatabaseClient;
  actor: Actor;
  trace: Trace;
  requestKey: string;
  action: AdminAuditAction;
  targetType: "USER" | "MANDATE" | "PROPOSAL";
  targetId: string;
  reason: string;
  beforeSummaryJson: unknown;
  requestSummaryJson: unknown;
}) {
  const claimed = await new AdminActionRepository(options.db).claimInTransaction(options.tx, {
    actor: options.actor,
    action: options.action,
    targetType: options.targetType,
    targetId: options.targetId,
    reason: options.reason,
    requestId: options.trace.requestId,
    correlationId: options.trace.correlationId,
    beforeSummaryJson: options.beforeSummaryJson,
    requestKey: options.requestKey,
    requestSummaryJson: options.requestSummaryJson,
  });
  if (!claimed.created) {
    if (claimed.status !== "COMPLETED")
      throw new AdminControlError("CONFLICT", 409, "This action key cannot be retried.");
    return { actionId: claimed.actionId, reuse: true as const };
  }
  return { actionId: claimed.actionId, reuse: false as const };
}

async function succeed(options: {
  tx: Prisma.TransactionClient;
  db: DatabaseClient;
  actor: Actor;
  trace: Trace;
  actionId: string;
  afterSummaryJson: unknown;
}) {
  await new AdminActionRepository(options.db).recordOutcomeInTransaction(
    options.tx,
    options.actionId,
    {
      actor: options.actor,
      requestId: options.trace.requestId,
      correlationId: options.trace.correlationId,
      result: "SUCCESS",
      afterSummaryJson: options.afterSummaryJson,
    },
  );
}

export function registerAdminControlRoutes(
  scope: FastifyInstance,
  options: {
    getDatabase: () => DatabaseClient;
    getSecret: () => string;
    runtime: () => AuthRuntime;
    identity: (request: FastifyRequest) => AdminIdentity;
    sendError: (
      reply: FastifyReply,
      request: FastifyRequest,
      code: string,
      status: number,
      message: string,
    ) => unknown;
    trace: (request: FastifyRequest) => Trace;
  },
) {
  const actorOf = (identity: AdminIdentity): Actor => ({
    principalId: identity.principalId,
    userId: identity.user.id,
    role: identity.role,
  });
  const operations = () =>
    new AdminOperationsRepository(options.getDatabase(), options.getSecret());
  async function mutate(request: FastifyRequest, reply: FastifyReply, run: () => Promise<object>) {
    try {
      return { ...(await run()), ...options.trace(request), pending: false };
    } catch (error) {
      if (error instanceof AdminControlError)
        return options.sendError(reply, request, error.code, error.status, error.message);
      try {
        controlError(error);
      } catch (mapped) {
        if (mapped instanceof AdminControlError)
          return options.sendError(reply, request, mapped.code, mapped.status, mapped.message);
        throw mapped;
      }
    }
  }
  async function requireFresh(request: FastifyRequest, reply: FastifyReply) {
    try {
      await requireFreshAdminAuth(options.runtime(), request);
      return true;
    } catch (error) {
      if (error instanceof AdminAuthError) {
        options.sendError(reply, request, error.code, error.status, error.message);
        return false;
      }
      throw error;
    }
  }

  scope.get("/users/:id/notes", async (request, reply) => {
    const id = idParam.safeParse(request.params);
    const query = AdminNoteQuerySchema.safeParse(request.query);
    if (!id.success || !query.success)
      return options.sendError(reply, request, "ADMIN_INVALID_REQUEST", 400, "Invalid filters.");
    const listed = await operations().listUserNotes(id.data.id, query.data);
    if (!listed)
      return options.sendError(reply, request, "ADMIN_TARGET_NOT_FOUND", 404, "User not found.");
    return { ...listed, ...options.trace(request) };
  });

  scope.post("/users/:id/disable", { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = parseUserDisable(request);
    if (!parsed.ok)
      return options.sendError(reply, request, parsed.code, parsed.status, parsed.message);
    if (!(await requireFresh(request, reply))) return;
    return mutate(request, reply, () =>
      disableUser({
        db: options.getDatabase(),
        secret: options.getSecret(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        userId: parsed.id,
        input: parsed.input,
      }),
    );
  });
  scope.post("/users/:id/enable", { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = parseUserAccess(request);
    if (!parsed.ok)
      return options.sendError(reply, request, parsed.code, parsed.status, parsed.message);
    return mutate(request, reply, () =>
      enableUser({
        db: options.getDatabase(),
        secret: options.getSecret(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        userId: parsed.id,
        input: parsed.input,
      }),
    );
  });
  scope.post("/users/:id/revoke-sessions", { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = parseUserAccess(request);
    if (!parsed.ok)
      return options.sendError(reply, request, parsed.code, parsed.status, parsed.message);
    if (!(await requireFresh(request, reply))) return;
    return mutate(request, reply, () =>
      revokeSessions({
        db: options.getDatabase(),
        secret: options.getSecret(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        userId: parsed.id,
        input: parsed.input,
      }),
    );
  });
  scope.post("/users/:id/disable-autonomy", { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = parseUserAccess(request);
    if (!parsed.ok)
      return options.sendError(reply, request, parsed.code, parsed.status, parsed.message);
    return mutate(request, reply, () =>
      disableAutonomy({
        db: options.getDatabase(),
        secret: options.getSecret(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        userId: parsed.id,
        input: parsed.input,
      }),
    );
  });
  scope.post("/users/:id/notes", { bodyLimit: 4096 }, async (request, reply) => {
    const id = idParam.safeParse(request.params);
    const input = AdminNoteCreateSchema.safeParse(request.body);
    if (!id.success || !input.success)
      return options.sendError(
        reply,
        request,
        "ADMIN_INVALID_REQUEST",
        400,
        "Provide a reason and a bounded note.",
      );
    return mutate(request, reply, () =>
      addNote({
        db: options.getDatabase(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        userId: id.data.id,
        input: input.data,
      }),
    );
  });
  scope.post("/mandates/:id/pause", { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = parseMandate(request);
    if (!parsed.ok)
      return options.sendError(reply, request, parsed.code, parsed.status, parsed.message);
    if (!(await requireFresh(request, reply))) return;
    return mutate(request, reply, () =>
      changeMandate({
        db: options.getDatabase(),
        secret: options.getSecret(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        mandateId: parsed.id,
        input: parsed.input,
        next: "PAUSED",
      }),
    );
  });
  scope.post("/mandates/:id/revoke", { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = parseMandate(request);
    if (!parsed.ok)
      return options.sendError(reply, request, parsed.code, parsed.status, parsed.message);
    if (!(await requireFresh(request, reply))) return;
    return mutate(request, reply, () =>
      changeMandate({
        db: options.getDatabase(),
        secret: options.getSecret(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        mandateId: parsed.id,
        input: parsed.input,
        next: "REVOKED",
      }),
    );
  });
  scope.post("/proposals/:id/re-evaluate", { bodyLimit: 4096 }, async (request, reply) => {
    const id = idParam.safeParse(request.params);
    const input = AdminProposalReevaluateMutationSchema.safeParse(request.body);
    if (!id.success || !input.success)
      return options.sendError(
        reply,
        request,
        "ADMIN_INVALID_REQUEST",
        400,
        "Check the action details and try again.",
      );
    return mutate(request, reply, () =>
      reevaluateProposal({
        db: options.getDatabase(),
        secret: options.getSecret(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        proposalId: id.data.id,
        input: input.data,
      }),
    );
  });
}

function parseUserDisable(request: FastifyRequest) {
  const id = idParam.safeParse(request.params);
  const input = AdminUserDisableMutationSchema.safeParse(request.body);
  if (!id.success || !input.success)
    return {
      ok: false as const,
      code: "ADMIN_INVALID_REQUEST",
      status: 400,
      message: "Check the action details and try again.",
    };
  if (input.data.typedConfirmation !== id.data.id)
    return {
      ok: false as const,
      code: "ADMIN_INVALID_REQUEST",
      status: 400,
      message: "Type the complete target ID exactly as shown.",
    };
  return { ok: true as const, id: id.data.id, input: input.data };
}

function parseUserAccess(request: FastifyRequest) {
  const id = idParam.safeParse(request.params);
  const input = AdminUserAccessMutationSchema.safeParse(request.body);
  if (!id.success || !input.success)
    return {
      ok: false as const,
      code: "ADMIN_INVALID_REQUEST",
      status: 400,
      message: "Check the action details and try again.",
    };
  return { ok: true as const, id: id.data.id, input: input.data };
}

function parseMandate(request: FastifyRequest) {
  const id = idParam.safeParse(request.params);
  const input = AdminMandateLifecycleMutationSchema.safeParse(request.body);
  if (!id.success || !input.success)
    return {
      ok: false as const,
      code: "ADMIN_INVALID_REQUEST",
      status: 400,
      message: "Check the action details and try again.",
    };
  if (input.data.typedConfirmation !== id.data.id)
    return {
      ok: false as const,
      code: "ADMIN_INVALID_REQUEST",
      status: 400,
      message: "Type the complete target ID exactly as shown.",
    };
  return { ok: true as const, id: id.data.id, input: input.data };
}

async function disableUser(input: {
  db: DatabaseClient;
  secret: string;
  actor: Actor;
  trace: Trace;
  userId: string;
  input: z.infer<typeof AdminUserDisableMutationSchema>;
}) {
  try {
    return await input.db.$transaction(async (tx) => {
      const user = await lockedUser(tx, input.userId);
      if (user.id === input.actor.userId || user.adminPrincipal?.active)
        throw new AdminControlError(
          "ADMIN_FORBIDDEN",
          403,
          "The singleton administrator account cannot be disabled.",
        );
      const before = {
        emailVerified: user.emailVerified,
        autonomousPurchasingEnabled: user.globalAutonomousPurchasingEnabled,
        disabledAt: user.disabledAt?.toISOString() ?? null,
        accessVersion: user.accessVersion,
      };
      const claimed = await claimAndReuse({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        requestKey: input.input.requestKey,
        action: "ADMIN_USER_DISABLED",
        targetType: "USER",
        targetId: user.id,
        reason: input.input.reason,
        beforeSummaryJson: before,
        requestSummaryJson: { accessVersion: input.input.expectedAccessVersion },
      });
      if (claimed.reuse) {
        const current = await new AdminOperationsRepository(tx, input.secret).getUser(user.id);
        return { data: current, changed: false, actionId: claimed.actionId };
      }
      assertExpectedUser(user, input.input.expectedUpdatedAt, input.input.expectedAccessVersion);
      const already = user.disabledAt !== null;
      const now = new Date();
      const updated = already
        ? user
        : await tx.user.update({
            where: { id: user.id },
            data: {
              disabledAt: now,
              disabledReason: input.input.reason,
              disabledByAdminId: input.actor.principalId,
              accessVersion: { increment: 1 },
            },
          });
      const revoked = await tx.session.deleteMany({ where: { userId: user.id } });
      if (!already) {
        await tx.auditEvent.create({
          data: {
            userId: user.id,
            eventType: "USER_DISABLED",
            entityType: "USER",
            entityId: user.id,
            payload: { source: "admin", previous: false, next: true },
          },
        });
      }
      const after = {
        emailVerified: updated.emailVerified,
        autonomousPurchasingEnabled: updated.globalAutonomousPurchasingEnabled,
        disabledAt: (updated.disabledAt ?? now).toISOString(),
        accessVersion: updated.accessVersion,
      };
      await succeed({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        actionId: claimed.actionId,
        afterSummaryJson: after,
      });
      const current = await new AdminOperationsRepository(tx, input.secret).getUser(user.id);
      return {
        data: current,
        changed: !already || revoked.count > 0,
        actionId: claimed.actionId,
      };
    });
  } catch (error) {
    controlError(error);
  }
}

async function enableUser(input: {
  db: DatabaseClient;
  secret: string;
  actor: Actor;
  trace: Trace;
  userId: string;
  input: z.infer<typeof AdminUserAccessMutationSchema>;
}) {
  try {
    return await input.db.$transaction(async (tx) => {
      const user = await lockedUser(tx, input.userId);
      const before = {
        emailVerified: user.emailVerified,
        autonomousPurchasingEnabled: user.globalAutonomousPurchasingEnabled,
        disabledAt: user.disabledAt?.toISOString() ?? null,
        accessVersion: user.accessVersion,
      };
      const claimed = await claimAndReuse({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        requestKey: input.input.requestKey,
        action: "ADMIN_USER_ENABLED",
        targetType: "USER",
        targetId: user.id,
        reason: input.input.reason,
        beforeSummaryJson: before,
        requestSummaryJson: { accessVersion: input.input.expectedAccessVersion },
      });
      if (claimed.reuse) {
        const current = await new AdminOperationsRepository(tx, input.secret).getUser(user.id);
        return { data: current, changed: false, actionId: claimed.actionId };
      }
      assertExpectedUser(user, input.input.expectedUpdatedAt, input.input.expectedAccessVersion);
      const already = user.disabledAt === null;
      const updated = already
        ? user
        : await tx.user.update({
            where: { id: user.id },
            data: {
              disabledAt: null,
              disabledReason: null,
              disabledByAdminId: null,
              accessVersion: { increment: 1 },
            },
          });
      if (!already) {
        await tx.auditEvent.create({
          data: {
            userId: user.id,
            eventType: "USER_ENABLED",
            entityType: "USER",
            entityId: user.id,
            payload: { source: "admin", previous: true, next: false },
          },
        });
      }
      await succeed({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        actionId: claimed.actionId,
        afterSummaryJson: {
          emailVerified: updated.emailVerified,
          autonomousPurchasingEnabled: updated.globalAutonomousPurchasingEnabled,
          disabledAt: null,
          accessVersion: updated.accessVersion,
        },
      });
      const current = await new AdminOperationsRepository(tx, input.secret).getUser(user.id);
      return { data: current, changed: !already, actionId: claimed.actionId };
    });
  } catch (error) {
    controlError(error);
  }
}

async function revokeSessions(input: {
  db: DatabaseClient;
  secret: string;
  actor: Actor;
  trace: Trace;
  userId: string;
  input: z.infer<typeof AdminUserAccessMutationSchema>;
}) {
  try {
    return await input.db.$transaction(async (tx) => {
      const user = await lockedUser(tx, input.userId);
      const before = {
        emailVerified: user.emailVerified,
        autonomousPurchasingEnabled: user.globalAutonomousPurchasingEnabled,
        disabledAt: user.disabledAt?.toISOString() ?? null,
        accessVersion: user.accessVersion,
      };
      const claimed = await claimAndReuse({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        requestKey: input.input.requestKey,
        action: "ADMIN_SESSIONS_REVOKED",
        targetType: "USER",
        targetId: user.id,
        reason: input.input.reason,
        beforeSummaryJson: before,
        requestSummaryJson: { accessVersion: input.input.expectedAccessVersion },
      });
      if (claimed.reuse) {
        const current = await new AdminOperationsRepository(tx, input.secret).getUser(user.id);
        return { data: current, changed: false, actionId: claimed.actionId };
      }
      assertExpectedUser(user, input.input.expectedUpdatedAt, input.input.expectedAccessVersion);
      const revoked = await tx.session.deleteMany({ where: { userId: user.id } });
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { accessVersion: { increment: 1 } },
      });
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          eventType: "USER_SESSIONS_REVOKED",
          entityType: "USER",
          entityId: user.id,
          payload: { source: "admin", next: true },
        },
      });
      await succeed({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        actionId: claimed.actionId,
        afterSummaryJson: {
          emailVerified: updated.emailVerified,
          autonomousPurchasingEnabled: updated.globalAutonomousPurchasingEnabled,
          disabledAt: updated.disabledAt?.toISOString() ?? null,
          accessVersion: updated.accessVersion,
        },
      });
      const current = await new AdminOperationsRepository(tx, input.secret).getUser(user.id);
      return { data: current, changed: revoked.count > 0, actionId: claimed.actionId };
    });
  } catch (error) {
    controlError(error);
  }
}

async function disableAutonomy(input: {
  db: DatabaseClient;
  secret: string;
  actor: Actor;
  trace: Trace;
  userId: string;
  input: z.infer<typeof AdminUserAccessMutationSchema>;
}) {
  try {
    return await input.db.$transaction(async (tx) => {
      const user = await lockedUser(tx, input.userId);
      const before = {
        emailVerified: user.emailVerified,
        autonomousPurchasingEnabled: user.globalAutonomousPurchasingEnabled,
        disabledAt: user.disabledAt?.toISOString() ?? null,
        accessVersion: user.accessVersion,
      };
      const claimed = await claimAndReuse({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        requestKey: input.input.requestKey,
        action: "ADMIN_AUTONOMY_DISABLED",
        targetType: "USER",
        targetId: user.id,
        reason: input.input.reason,
        beforeSummaryJson: before,
        requestSummaryJson: { accessVersion: input.input.expectedAccessVersion },
      });
      if (claimed.reuse) {
        const current = await new AdminOperationsRepository(tx, input.secret).getUser(user.id);
        return { data: current, changed: false, actionId: claimed.actionId };
      }
      assertExpectedUser(user, input.input.expectedUpdatedAt, input.input.expectedAccessVersion);
      const already = !user.globalAutonomousPurchasingEnabled;
      const updated = already
        ? user
        : await tx.user.update({
            where: { id: user.id },
            data: {
              globalAutonomousPurchasingEnabled: false,
              accessVersion: { increment: 1 },
            },
          });
      if (!already) {
        await tx.auditEvent.create({
          data: {
            userId: user.id,
            eventType: "GLOBAL_AUTONOMY_UPDATED",
            entityType: "USER",
            entityId: user.id,
            payload: { previous: true, next: false, source: "admin" },
          },
        });
      }
      await succeed({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        actionId: claimed.actionId,
        afterSummaryJson: {
          emailVerified: updated.emailVerified,
          autonomousPurchasingEnabled: false,
          disabledAt: updated.disabledAt?.toISOString() ?? null,
          accessVersion: updated.accessVersion,
        },
      });
      const current = await new AdminOperationsRepository(tx, input.secret).getUser(user.id);
      return { data: current, changed: !already, actionId: claimed.actionId };
    });
  } catch (error) {
    controlError(error);
  }
}

async function addNote(input: {
  db: DatabaseClient;
  actor: Actor;
  trace: Trace;
  userId: string;
  input: z.infer<typeof AdminNoteCreateSchema>;
}) {
  try {
    return await input.db.$transaction(async (tx) => {
      const user = await lockedUser(tx, input.userId);
      const hash = noteHash(input.input.body);
      const before = {
        emailVerified: user.emailVerified,
        autonomousPurchasingEnabled: user.globalAutonomousPurchasingEnabled,
        disabledAt: user.disabledAt?.toISOString() ?? null,
        accessVersion: user.accessVersion,
        noteHash: hash,
      };
      const claimed = await claimAndReuse({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        requestKey: input.input.requestKey,
        action: "ADMIN_NOTE_ADDED",
        targetType: "USER",
        targetId: user.id,
        reason: input.input.reason,
        beforeSummaryJson: before,
        requestSummaryJson: { noteHash: hash, accessVersion: user.accessVersion },
      });
      if (claimed.reuse) {
        const existing = await tx.adminNote.findFirst({
          where: { userId: user.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        if (!existing)
          throw new AdminControlError("CONFLICT", 409, "This action key cannot be retried.");
        const author = await tx.adminPrincipal.findUnique({
          where: { id: existing.authorAdminId },
          select: { user: { select: { name: true } } },
        });
        return {
          data: {
            id: existing.id,
            userId: existing.userId,
            body: existing.body,
            authorPrincipalId: existing.authorAdminId,
            authorName: author?.user.name ?? null,
            createdAt: existing.createdAt.toISOString(),
          },
          changed: false,
          actionId: claimed.actionId,
        };
      }
      const note = await tx.adminNote.create({
        data: {
          userId: user.id,
          authorAdminId: input.actor.principalId,
          body: input.input.body,
        },
      });
      const author = await tx.adminPrincipal.findUnique({
        where: { id: input.actor.principalId },
        select: { user: { select: { name: true } } },
      });
      await succeed({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        actionId: claimed.actionId,
        afterSummaryJson: {
          emailVerified: user.emailVerified,
          autonomousPurchasingEnabled: user.globalAutonomousPurchasingEnabled,
          disabledAt: user.disabledAt?.toISOString() ?? null,
          accessVersion: user.accessVersion,
          noteHash: hash,
        },
      });
      return {
        data: {
          id: note.id,
          userId: note.userId,
          body: note.body,
          authorPrincipalId: note.authorAdminId,
          authorName: author?.user.name ?? null,
          createdAt: note.createdAt.toISOString(),
        },
        changed: true,
        actionId: claimed.actionId,
      };
    });
  } catch (error) {
    controlError(error);
  }
}

async function changeMandate(input: {
  db: DatabaseClient;
  secret: string;
  actor: Actor;
  trace: Trace;
  mandateId: string;
  input: z.infer<typeof AdminMandateLifecycleMutationSchema>;
  next: "PAUSED" | "REVOKED";
}) {
  try {
    return await input.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Mandate" WHERE id = ${input.mandateId} FOR UPDATE`;
      const mandate = await tx.mandate.findUnique({
        where: { id: input.mandateId },
        include: { user: { select: { id: true } } },
      });
      if (!mandate)
        throw new AdminControlError("ADMIN_TARGET_NOT_FOUND", 404, "Mandate not found.");
      const action = input.next === "PAUSED" ? "ADMIN_MANDATE_PAUSED" : "ADMIN_MANDATE_REVOKED";
      const before = { status: mandate.status, version: mandate.version, currency: "USD" as const };
      const claimed = await claimAndReuse({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        requestKey: input.input.requestKey,
        action,
        targetType: "MANDATE",
        targetId: mandate.id,
        reason: input.input.reason,
        beforeSummaryJson: before,
        requestSummaryJson: {
          status: input.input.expectedStatus,
          version: input.input.expectedVersion,
        },
      });
      if (claimed.reuse) {
        const current = await new AdminOperationsRepository(tx, input.secret).getMandate(
          mandate.id,
        );
        return { data: current, changed: false, actionId: claimed.actionId };
      }
      if (
        mandate.version !== input.input.expectedVersion ||
        mandate.status !== input.input.expectedStatus
      )
        throw new AdminControlError(
          "CONFLICT",
          409,
          "The record changed. Reload its current state before trying again.",
        );
      const repository = new MandateRepository(input.db);
      const updated =
        input.next === "PAUSED"
          ? await repository.pauseInTransaction(tx, mandate.id, mandate.userId, mandate.version)
          : await repository.revokeInTransaction(tx, mandate.id, mandate.userId, mandate.version);
      await succeed({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        actionId: claimed.actionId,
        afterSummaryJson: { status: updated.status, version: updated.version, currency: "USD" },
      });
      const current = await new AdminOperationsRepository(tx, input.secret).getMandate(mandate.id);
      return {
        data: current,
        changed: updated.status !== mandate.status,
        actionId: claimed.actionId,
      };
    });
  } catch (error) {
    controlError(error);
  }
}

async function reevaluateProposal(input: {
  db: DatabaseClient;
  secret: string;
  actor: Actor;
  trace: Trace;
  proposalId: string;
  input: z.infer<typeof AdminProposalReevaluateMutationSchema>;
}) {
  try {
    return await input.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PurchaseProposal" WHERE id = ${input.proposalId} FOR UPDATE`;
      const proposal = await tx.purchaseProposal.findUnique({ where: { id: input.proposalId } });
      if (!proposal)
        throw new AdminControlError("ADMIN_TARGET_NOT_FOUND", 404, "Proposal not found.");
      if (proposal.isSample)
        throw new AdminControlError(
          "INVALID_STATE",
          409,
          "Sample proposals cannot be targeted by controls.",
        );
      const before = {
        status: proposal.status,
        amountMinor: Number(proposal.total),
        currency: "USD" as const,
        isSample: proposal.isSample,
      };
      const claimed = await claimAndReuse({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        requestKey: input.input.requestKey,
        action: "ADMIN_PROPOSAL_RE_EVALUATED",
        targetType: "PROPOSAL",
        targetId: proposal.id,
        reason: input.input.reason,
        beforeSummaryJson: before,
        requestSummaryJson: { status: input.input.expectedStatus, isSample: false },
      });
      if (claimed.reuse) {
        const current = await new AdminOperationsRepository(tx, input.secret).getProposal(
          proposal.id,
        );
        return { data: current, changed: false, actionId: claimed.actionId };
      }
      if (
        proposal.status !== input.input.expectedStatus ||
        proposal.updatedAt.toISOString() !== input.input.expectedUpdatedAt
      )
        throw new AdminControlError(
          "CONFLICT",
          409,
          "The record changed. Reload its current state before trying again.",
        );
      const evaluated = await evaluateProposalInTransaction(
        tx,
        { id: proposal.userId },
        proposal.id,
        { allowDisabledAccount: true },
      );
      await succeed({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        actionId: claimed.actionId,
        afterSummaryJson: {
          status: evaluated.proposal.status,
          amountMinor: evaluated.proposal.total,
          currency: "USD",
          isSample: false,
        },
      });
      const current = await new AdminOperationsRepository(tx, input.secret).getProposal(
        proposal.id,
      );
      return { data: current, changed: true, actionId: claimed.actionId };
    });
  } catch (error) {
    controlError(error);
  }
}
