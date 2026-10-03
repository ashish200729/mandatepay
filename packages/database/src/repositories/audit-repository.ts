import type { PrismaClient, Prisma } from "../generated/prisma/client.js";
import { AuditEntityType, AuditEventType } from "../generated/prisma/enums.js";
import { getPrismaClient } from "../client.js";
import { DatabaseError } from "../errors.js";

export interface AppendAuditEventInput {
  userId: string;
  eventType: AuditEventType;
  entityType: AuditEntityType;
  entityId: string;
  payload: Prisma.InputJsonValue;
  dedupeKey?: string | null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => JSON.stringify(key) + ":" + stableJson(entry))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function assertSafePayload(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertSafePayload(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/(prompt|password|secret|token|cvv|card(number)?)/iu.test(key)) {
      throw new DatabaseError(
        "INVALID_DOMAIN_INPUT",
        "Audit payload contains a prohibited sensitive field.",
      );
    }
    assertSafePayload(entry);
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export class AuditRepository {
  constructor(private readonly db: PrismaClient = getPrismaClient()) {}

  async append(input: AppendAuditEventInput) {
    if (!input.entityId.trim()) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "Audit entityId is required.");
    }
    assertSafePayload(input.payload);

    if (input.dedupeKey) {
      const existing = await this.db.auditEvent.findUnique({
        where: { dedupeKey: input.dedupeKey },
      });
      if (existing) {
        if (existing.userId !== input.userId) {
          throw new DatabaseError(
            "OWNERSHIP_REQUIRED",
            "Audit dedupe key belongs to another user.",
          );
        }
        if (stableJson(existing.payload) !== stableJson(input.payload)) {
          throw new DatabaseError(
            "CONFLICT",
            "Audit dedupe key was reused with different payload.",
          );
        }
        return existing;
      }
    }

    try {
      return await this.db.auditEvent.create({
        data: {
          userId: input.userId,
          eventType: input.eventType,
          entityType: input.entityType,
          entityId: input.entityId,
          payload: input.payload,
          dedupeKey: input.dedupeKey ?? null,
        },
      });
    } catch (error) {
      if (!input.dedupeKey || !isUniqueConstraintError(error)) throw error;
      const existing = await this.db.auditEvent.findUnique({
        where: { dedupeKey: input.dedupeKey },
      });
      if (!existing) throw error;
      if (existing.userId !== input.userId) {
        throw new DatabaseError("OWNERSHIP_REQUIRED", "Audit dedupe key belongs to another user.");
      }
      if (stableJson(existing.payload) !== stableJson(input.payload)) {
        throw new DatabaseError("CONFLICT", "Audit dedupe key was reused with different payload.");
      }
      return existing;
    }
  }

  listForUser(userId: string, take = 100) {
    return this.db.auditEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      take: Math.min(Math.max(take, 1), 500),
    });
  }

  listForEntity(userId: string, entityType: AuditEntityType, entityId: string) {
    return this.db.auditEvent.findMany({
      where: { userId, entityType, entityId },
      orderBy: { createdAt: "asc" },
    });
  }
}
