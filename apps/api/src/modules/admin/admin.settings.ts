import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  compareAndSetPlatformSetting,
  AdminActionRepository,
  isDatabaseError,
  type DatabaseClient,
} from "@mandatepay/database";
import {
  ADMIN_SETTING_KEYS,
  AdminPlatformSettingMutationSchema,
  isCriticalPlatformSetting,
  isPlatformSettingKey,
  platformSettingAuditAction,
  presentPlatformSetting,
} from "@mandatepay/shared";
import type { AuthRuntime } from "../../auth.js";
import { AdminAuthError, requireFreshAdminAuth, type AdminIdentity } from "./admin.auth.js";

type Actor = { principalId: string; userId: string; role: "ADMIN_SUPER" };
type Trace = { requestId: string; correlationId: string };

export class AdminSettingError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminSettingError";
  }
}

function mapError(error: unknown): never {
  if (error instanceof AdminSettingError) throw error;
  if (isDatabaseError(error)) {
    if (error.code === "CONFLICT")
      throw new AdminSettingError("CONFLICT", 409, "The setting changed. Reload it and try again.");
    if (error.code === "INVALID_DOMAIN_INPUT")
      throw new AdminSettingError("ADMIN_INVALID_REQUEST", 400, "Check the setting and try again.");
  }
  throw error;
}

export function registerAdminSettingRoutes(
  scope: FastifyInstance,
  options: {
    getDatabase: () => DatabaseClient;
    identity: (request: FastifyRequest) => AdminIdentity;
    sendError: (
      reply: FastifyReply,
      request: FastifyRequest,
      code: string,
      status: number,
      message: string,
    ) => unknown;
    trace: (request: FastifyRequest) => Trace;
    runtime: () => AuthRuntime;
  },
) {
  scope.get("/settings", async (request) => {
    const rows = await options.getDatabase().platformSetting.findMany({
      select: {
        key: true,
        valueJson: true,
        version: true,
        updatedByAdminId: true,
        updatedAt: true,
      },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return {
      data: ADMIN_SETTING_KEYS.map((key) => presentPlatformSetting(key, byKey.get(key) ?? null)),
      page: { nextCursor: null, limit: ADMIN_SETTING_KEYS.length },
      ...options.trace(request),
    };
  });

  scope.patch<{ Params: { key: string } }>(
    "/settings/:key",
    { bodyLimit: 4096 },
    async (request, reply) => {
      if (!isPlatformSettingKey(request.params.key))
        return options.sendError(
          reply,
          request,
          "ADMIN_SETTING_INVALID",
          400,
          "That platform setting is not available.",
        );
      const key = request.params.key;
      const parsed = AdminPlatformSettingMutationSchema.safeParse(request.body);
      if (!parsed.success)
        return options.sendError(
          reply,
          request,
          "ADMIN_SETTING_INVALID",
          400,
          "Provide a boolean value, the current version, a reason, and a request key.",
        );
      if (isCriticalPlatformSetting(key) && parsed.data.typedConfirmation !== key)
        return options.sendError(
          reply,
          request,
          "ADMIN_CONFIRMATION_REQUIRED",
          400,
          "Type the setting key to confirm this change.",
        );
      if (isCriticalPlatformSetting(key)) {
        try {
          await requireFreshAdminAuth(options.runtime(), request);
        } catch (error) {
          if (error instanceof AdminAuthError)
            return options.sendError(reply, request, error.code, error.status, error.message);
          throw error;
        }
      }
      const actor: Actor = {
        principalId: options.identity(request).principalId,
        userId: options.identity(request).user.id,
        role: options.identity(request).role,
      };
      const trace = options.trace(request);
      try {
        const result = await options.getDatabase().$transaction(async (tx) => {
          const existing = await tx.platformSetting.findUnique({ where: { key } });
          const before = presentPlatformSetting(key, existing);
          const claimed = await new AdminActionRepository(options.getDatabase()).claimInTransaction(
            tx,
            {
              actor,
              action: platformSettingAuditAction(key),
              targetType: "PLATFORM_SETTING",
              targetId: key,
              reason: parsed.data.reason,
              requestId: trace.requestId,
              correlationId: trace.correlationId,
              beforeSummaryJson: {
                key,
                value: before.value,
                version: before.version,
              },
              requestKey: parsed.data.requestKey,
              requestSummaryJson: {
                key,
                value: parsed.data.value,
                version: parsed.data.expectedVersion,
              },
            },
          );
          if (!claimed.created) {
            if (claimed.status !== "COMPLETED")
              throw new AdminSettingError("CONFLICT", 409, "This action key cannot be retried.");
            const current = await tx.platformSetting.findUnique({ where: { key } });
            return {
              data: presentPlatformSetting(key, current),
              changed: false,
              actionId: claimed.actionId,
            };
          }
          const saved = await compareAndSetPlatformSetting(tx, {
            key,
            expectedVersion: parsed.data.expectedVersion,
            value: parsed.data.value,
            adminId: actor.principalId,
          });
          const after = {
            key,
            value: saved.value,
            version: saved.version,
          };
          await new AdminActionRepository(options.getDatabase()).recordOutcomeInTransaction(
            tx,
            claimed.actionId,
            {
              actor,
              requestId: trace.requestId,
              correlationId: trace.correlationId,
              result: "SUCCESS",
              afterSummaryJson: after,
            },
          );
          return {
            data: presentPlatformSetting(key, {
              valueJson: saved.value,
              version: saved.version,
              updatedByAdminId: saved.updatedByAdminId,
              updatedAt: saved.updatedAt,
            }),
            changed: saved.changed,
            actionId: claimed.actionId,
          };
        });
        return { ...result, pending: false, ...trace };
      } catch (error) {
        try {
          mapError(error);
        } catch (mapped) {
          if (mapped instanceof AdminSettingError)
            return options.sendError(reply, request, mapped.code, mapped.status, mapped.message);
          throw mapped;
        }
      }
    },
  );
}
