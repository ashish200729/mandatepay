import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  ADMIN_ACTION_TARGET,
  AdminAuditActionSchema,
  AdminAuditTargetSchema,
  AdminAuditResultSchema,
  AdminAuditErrorCodeSchema,
  AdminResourceIdSchema,
  AdminTraceIdSchema,
  AdminReasonSchema,
  buildAdminSummary,
  parseAdminTargetId,
  parseAdminAuditEvent,
  isAdminActionResultValid,
  type AdminAuditEventDTO,
  AdminAuditQuerySchema,
  type AdminAuditQuery,
} from "@mandatepay/shared";
import { Prisma } from "../generated/prisma/client.js";
import { getPrismaClient } from "../client.js";
import { DatabaseError } from "../errors.js";

const actorSchema = z
  .object({ principalId: z.uuid(), userId: AdminResourceIdSchema, role: z.literal("ADMIN_SUPER") })
  .strict();
const inputSchema = z
  .object({
    actor: actorSchema.nullable(),
    action: AdminAuditActionSchema,
    targetType: AdminAuditTargetSchema,
    targetId: z.string(),
    reason: AdminReasonSchema,
    requestId: AdminTraceIdSchema,
    correlationId: AdminTraceIdSchema,
    actionId: z.uuid().optional(),
    beforeSummaryJson: z.unknown().optional(),
    afterSummaryJson: z.unknown().optional(),
    result: AdminAuditResultSchema,
    errorCode: AdminAuditErrorCodeSchema.optional(),
  })
  .strict();
export type AppendAdminAuditEventInput = z.input<typeof inputSchema>;
export type AdminAuditActor = z.infer<typeof actorSchema>;
export function normalizeAdminAuditInput(input: AppendAdminAuditEventInput) {
  try {
    const value = inputSchema.parse(input);
    if (ADMIN_ACTION_TARGET[value.action] !== value.targetType) throw new Error();
    if (!isAdminActionResultValid(value.action, value.result)) throw new Error();
    if (!value.actor && !["ADMIN_LOGIN_FAILED", "ADMIN_REAUTH_FAILED"].includes(value.action))
      throw new Error();
    if (
      (value.result === "SUCCESS" && value.errorCode) ||
      (value.result === "FAILURE" && !value.errorCode)
    )
      throw new Error();
    return {
      ...value,
      targetId: parseAdminTargetId(value.targetType, value.targetId),
      beforeSummaryJson: buildAdminSummary(value.targetType, value.beforeSummaryJson),
      afterSummaryJson: buildAdminSummary(value.targetType, value.afterSummaryJson),
    };
  } catch {
    throw new DatabaseError("INVALID_DOMAIN_INPUT", "Invalid or unsafe admin audit data.");
  }
}
export const adminAuditSelect = {
  id: true,
  actorAdminId: true,
  actorUserId: true,
  role: true,
  action: true,
  targetType: true,
  targetId: true,
  reason: true,
  requestId: true,
  correlationId: true,
  actionId: true,
  beforeSummaryJson: true,
  afterSummaryJson: true,
  result: true,
  errorCode: true,
  createdAt: true,
} as const;
function dto(
  row: Prisma.AdminAuditEventGetPayload<{ select: typeof adminAuditSelect }>,
): AdminAuditEventDTO {
  const value = parseAdminAuditEvent({ ...row, createdAt: row.createdAt.toISOString() });
  if (!value) throw new DatabaseError("INVALID_STATE", "Stored admin audit data is unsafe.");
  return value;
}
export { AdminAuditQuerySchema } from "@mandatepay/shared";
export type { AdminAuditQuery } from "@mandatepay/shared";
type Store = Pick<Prisma.TransactionClient, "adminAuditEvent">;

/** Append/read only; accepts a transaction client to commit with the mutation. */
export class AdminAuditRepository {
  constructor(
    private readonly db: Store = getPrismaClient(),
    private readonly cursorSecret?: string,
  ) {}

  async append(input: AppendAdminAuditEventInput) {
    const value = normalizeAdminAuditInput(input);
    return dto(
      await this.db.adminAuditEvent.create({
        data: {
          actorAdminId: value.actor?.principalId ?? null,
          actorUserId: value.actor?.userId ?? null,
          role: value.actor?.role ?? null,
          action: value.action,
          targetType: value.targetType,
          targetId: value.targetId,
          reason: value.reason,
          requestId: value.requestId,
          correlationId: value.correlationId,
          actionId: value.actionId ?? null,
          beforeSummaryJson: value.beforeSummaryJson ?? Prisma.DbNull,
          afterSummaryJson: value.afterSummaryJson ?? Prisma.DbNull,
          result: value.result,
          errorCode: value.errorCode ?? null,
        },
        select: adminAuditSelect,
      }),
    );
  }
  async findById(id: string) {
    if (!z.uuid().safeParse(id).success)
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "Invalid event ID.");
    const row = await this.db.adminAuditEvent.findUnique({
      where: { id },
      select: adminAuditSelect,
    });
    return row ? dto(row) : null;
  }
  async list(input: AdminAuditQuery) {
    const parsed = AdminAuditQuerySchema.safeParse(input);
    if (!parsed.success) throw new DatabaseError("INVALID_DOMAIN_INPUT", "Invalid audit filters.");
    if (!this.cursorSecret || this.cursorSecret.length < 32)
      throw new DatabaseError("INVALID_STATE", "Audit cursor configuration is unavailable.");
    const { cursor, ...filters } = parsed.data;
    const binding = createHash("sha256").update(JSON.stringify(filters)).digest("hex");
    let boundary: { createdAt: string; id: string } | undefined;
    if (cursor) {
      try {
        const [payload, signature, extra] = cursor.split(".");
        if (!payload || !signature || extra) throw new Error();
        const expected = createHmac("sha256", this.cursorSecret).update(payload).digest();
        const supplied = Buffer.from(signature, "base64url");
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
          throw new Error();
        const data = z
          .object({ createdAt: z.iso.datetime(), id: z.uuid(), binding: z.literal(binding) })
          .strict()
          .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
        boundary = data;
      } catch {
        throw new DatabaseError("INVALID_DOMAIN_INPUT", "Invalid audit cursor.");
      }
    }
    const where: Prisma.AdminAuditEventWhereInput = {
      action: filters.action,
      targetType: filters.targetType,
      targetId: filters.targetId,
      result: filters.result,
      actorAdminId: filters.actorAdminId,
      correlationId: filters.correlationId,
      ...(filters.from
        ? { createdAt: { gte: new Date(filters.from), lt: new Date(filters.to!) } }
        : {}),
      ...(boundary
        ? {
            OR: [
              { createdAt: { lt: new Date(boundary.createdAt) } },
              { createdAt: new Date(boundary.createdAt), id: { lt: boundary.id } },
            ],
          }
        : {}),
    };
    const rows = await this.db.adminAuditEvent.findMany({
      where,
      select: adminAuditSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filters.limit + 1,
    });
    const page = rows.slice(0, filters.limit);
    const last = page.at(-1);
    let nextCursor: string | null = null;
    if (rows.length > filters.limit && last) {
      const payload = Buffer.from(
        JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id, binding }),
      ).toString("base64url");
      nextCursor =
        payload + "." + createHmac("sha256", this.cursorSecret).update(payload).digest("base64url");
    }
    return { data: page.map(dto), page: { limit: filters.limit, nextCursor } };
  }
}
