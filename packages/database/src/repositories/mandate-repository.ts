import type { PrismaClient, Prisma } from "../generated/prisma/client.js";
import { createHash } from "node:crypto";
import { CanonicalMandateSchema, type CanonicalMandateInput } from "@mandatepay/shared";
import {
  AuditEntityType,
  AuditEventType,
  MandateStatus,
  MandateRuleType,
  RuleOperator,
} from "../generated/prisma/enums.js";
import { DatabaseError } from "../errors.js";
import {
  assertCurrency,
  assertDateRange,
  assertMinorUnits,
  assertPositiveMinorUnits,
  SUPPORTED_CURRENCY,
} from "../money.js";
import { getPrismaClient } from "../client.js";

export interface MandateRuleInput {
  ruleType: MandateRuleType;
  operator: RuleOperator;
  value: Prisma.InputJsonValue;
}

export interface MandateVersionInput {
  title: string;
  originalPrompt: string;
  productIntent?: string;
  currency?: string;
  autoSpendLimit: bigint;
  transactionLimit: bigint;
  dailyLimit?: bigint | null;
  weeklyLimit?: bigint | null;
  monthlyLimit?: bigint | null;
  spendTimeZone?: string;
  startsAt: Date;
  expiresAt: Date;
  rules?: readonly MandateRuleInput[];
  canonicalRules?: CanonicalMandateInput;
}

export interface CreateMandateInput extends MandateVersionInput {
  userId: string;
  status?: MandateStatus;
  creationRequestKey?: string | null;
}

const mandateWithVersion = {
  activeVersion: { include: { rules: true } },
  versions: { orderBy: { version: "desc" as const }, include: { rules: true } },
} as const;

function ruleValues(input: MandateVersionInput, ruleType: MandateRuleType): string[] {
  const values = input.rules
    ?.filter((rule) => rule.ruleType === ruleType)
    .flatMap((rule) => (Array.isArray(rule.value) ? rule.value : [rule.value]))
    .filter((value): value is string => typeof value === "string");
  return values ?? [];
}

function assertProjectableRules(input: MandateVersionInput): void {
  const unsupportedTypes: MandateRuleType[] = [
    MandateRuleType.REQUIRED_SPECIFICATION,
    MandateRuleType.BLOCKED_SPECIFICATION,
    MandateRuleType.ALLOWED_CURRENCY,
  ];
  const unsupported = input.rules?.filter((rule) => unsupportedTypes.includes(rule.ruleType));
  if (unsupported?.length) {
    throw new DatabaseError(
      "INVALID_DOMAIN_INPUT",
      "Mandate rules contain conditions not represented by the canonical contract.",
    );
  }
}

function canonicalRulesForInput(input: MandateVersionInput): Prisma.InputJsonValue {
  assertProjectableRules(input);
  const currency = input.currency ?? SUPPORTED_CURRENCY;
  if (currency !== SUPPORTED_CURRENCY) {
    throw new DatabaseError("INVALID_CURRENCY", "Only USD canonical mandates are supported.");
  }
  const candidate: CanonicalMandateInput = input.canonicalRules ?? {
    title: input.title,
    productIntent: input.productIntent ?? input.title,
    currency,
    timezone: "UTC",
    allowedBrands: ruleValues(input, MandateRuleType.ALLOWED_BRAND),
    blockedBrands: ruleValues(input, MandateRuleType.BLOCKED_BRAND),
    allowedCategories: ruleValues(input, MandateRuleType.ALLOWED_CATEGORY),
    blockedCategories: ruleValues(input, MandateRuleType.BLOCKED_CATEGORY),
    allowedConditions: (() => {
      const raw = ruleValues(input, MandateRuleType.REQUIRED_CONDITION);
      const valid = raw.filter((value): value is "NEW" | "USED" | "REFURBISHED" =>
        ["NEW", "USED", "REFURBISHED"].includes(value as "NEW" | "USED" | "REFURBISHED"),
      );
      if (raw.length !== valid.length) {
        throw new DatabaseError("INVALID_DOMAIN_INPUT", "Mandate condition rule is invalid.");
      }
      return valid.length ? valid : ["NEW"];
    })(),
    autoSpendLimit: Number(input.autoSpendLimit),
    transactionLimit: Number(input.transactionLimit),
    dailyLimit: input.dailyLimit == null ? undefined : Number(input.dailyLimit),
    weeklyLimit: input.weeklyLimit == null ? undefined : Number(input.weeklyLimit),
    monthlyLimit: input.monthlyLimit == null ? undefined : Number(input.monthlyLimit),
    quantityLimit: 1,
    allowedMerchants: ruleValues(input, MandateRuleType.ALLOWED_MERCHANT),
    blockedMerchants: ruleValues(input, MandateRuleType.BLOCKED_MERCHANT),
    newMerchantRequiresApproval: false,
    startsAt: input.startsAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };

  let parsed: ReturnType<typeof CanonicalMandateSchema.parse>;
  try {
    parsed = CanonicalMandateSchema.parse(candidate);
  } catch {
    throw new DatabaseError(
      "INVALID_DOMAIN_INPUT",
      "canonicalRules must be a valid canonical mandate.",
    );
  }
  if (
    parsed.title !== input.title.trim() ||
    parsed.currency !== currency ||
    parsed.timezone !== (input.spendTimeZone ?? "UTC") ||
    parsed.startsAt !== input.startsAt.toISOString() ||
    parsed.expiresAt !== input.expiresAt.toISOString() ||
    (input.productIntent !== undefined && parsed.productIntent !== input.productIntent) ||
    parsed.autoSpendLimit !== Number(input.autoSpendLimit) ||
    parsed.transactionLimit !== Number(input.transactionLimit) ||
    (parsed.dailyLimit ?? null) !== (input.dailyLimit == null ? null : Number(input.dailyLimit)) ||
    (parsed.weeklyLimit ?? null) !==
      (input.weeklyLimit == null ? null : Number(input.weeklyLimit)) ||
    (parsed.monthlyLimit ?? null) !==
      (input.monthlyLimit == null ? null : Number(input.monthlyLimit))
  ) {
    throw new DatabaseError(
      "CONFLICT",
      "canonicalRules financial limits must match the mandate version.",
    );
  }
  return parsed as unknown as Prisma.InputJsonValue;
}

function validateVersionInput(input: MandateVersionInput): void {
  const currency = input.currency ?? SUPPORTED_CURRENCY;
  assertCurrency(currency);
  assertMinorUnits(input.autoSpendLimit, "autoSpendLimit");
  assertPositiveMinorUnits(input.transactionLimit, "transactionLimit");
  if (input.dailyLimit !== null && input.dailyLimit !== undefined) {
    assertPositiveMinorUnits(input.dailyLimit, "dailyLimit");
  }
  if (input.weeklyLimit !== null && input.weeklyLimit !== undefined) {
    assertPositiveMinorUnits(input.weeklyLimit, "weeklyLimit");
  }
  if (input.monthlyLimit !== null && input.monthlyLimit !== undefined) {
    assertPositiveMinorUnits(input.monthlyLimit, "monthlyLimit");
  }

  if (input.autoSpendLimit > input.transactionLimit) {
    throw new DatabaseError("INVALID_MONEY", "autoSpendLimit cannot exceed transactionLimit.");
  }
  if (!input.title.trim() || !input.originalPrompt.trim()) {
    throw new DatabaseError(
      "INVALID_DOMAIN_INPUT",
      "Mandate title and original prompt are required.",
    );
  }
  assertDateRange(input.startsAt, input.expiresAt, "mandate validity");
  if (input.spendTimeZone !== undefined && input.spendTimeZone !== "UTC") {
    throw new DatabaseError("INVALID_DOMAIN_INPUT", "Mandate spendTimeZone must be UTC.");
  }
  canonicalRulesForInput(input);
}

function versionData(input: MandateVersionInput, version: number) {
  return {
    version,
    title: input.title.trim(),
    originalPrompt: input.originalPrompt,
    currency: input.currency ?? SUPPORTED_CURRENCY,
    autoSpendLimit: input.autoSpendLimit,
    transactionLimit: input.transactionLimit,
    dailyLimit: input.dailyLimit ?? null,
    weeklyLimit: input.weeklyLimit ?? null,
    monthlyLimit: input.monthlyLimit ?? null,
    spendTimeZone: input.spendTimeZone ?? "UTC",
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
  };
}

function versionSnapshotData(
  input: MandateVersionInput,
  version: number,
  canonicalRules = canonicalRulesForInput(input),
) {
  return {
    ...versionData(input, version),
    canonicalRules,
  };
}

export class MandateRepository {
  constructor(private readonly db: PrismaClient = getPrismaClient()) {}

  async create(input: CreateMandateInput) {
    validateVersionInput(input);
    const canonicalRules = canonicalRulesForInput(input);
    const creationFingerprint = createHash("sha256")
      .update(JSON.stringify({ canonicalRules, originalPrompt: input.originalPrompt }))
      .digest("hex");
    if (input.creationRequestKey && input.creationRequestKey.length > 255) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "creationRequestKey is too long.");
    }

    return this.db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', input.userId);
      if (input.creationRequestKey) {
        const existing = await tx.mandate.findFirst({
          where: { userId: input.userId, creationRequestKey: input.creationRequestKey },
          include: mandateWithVersion,
        });
        if (existing) {
          if (existing.creationFingerprint !== creationFingerprint) {
            throw new DatabaseError(
              "CONFLICT",
              "creationRequestKey was reused with different mandate data.",
            );
          }
          return existing;
        }
      }
      const mandate = await tx.mandate.create({
        data: {
          userId: input.userId,
          status: input.status ?? MandateStatus.DRAFT,
          creationRequestKey: input.creationRequestKey ?? null,
          creationFingerprint,
          ...versionData(input, 1),
        },
      });

      const version = await tx.mandateVersion.create({
        data: {
          mandateId: mandate.id,
          ...versionSnapshotData(input, 1, canonicalRules),
        },
      });

      if (input.rules?.length) {
        await tx.mandateRule.createMany({
          data: input.rules.map((rule) => ({
            mandateId: mandate.id,
            mandateVersionId: version.id,
            ruleType: rule.ruleType,
            operator: rule.operator,
            value: rule.value,
          })),
        });
      }
      await tx.auditEvent.create({
        data: {
          userId: mandate.userId,
          eventType: AuditEventType.MANDATE_CREATED,
          entityType: AuditEntityType.MANDATE,
          entityId: mandate.id,
          payload: {
            mandateId: mandate.id,
            mandateVersionId: version.id,
            version: 1,
            status: mandate.status,
          },
        },
      });

      return tx.mandate.update({
        where: { id: mandate.id },
        data: { activeVersionId: version.id },
        include: mandateWithVersion,
      });
    });
  }

  async getByIdForUser(mandateId: string, userId: string) {
    const mandate = await this.db.mandate.findFirst({
      where: { id: mandateId, userId },
      include: mandateWithVersion,
    });

    if (!mandate) {
      throw new DatabaseError("NOT_FOUND", "Mandate was not found for this user.");
    }

    return mandate;
  }

  listForUser(userId: string) {
    return this.db.mandate.findMany({
      where: { userId },
      include: { activeVersion: { include: { rules: true } } },
      orderBy: { updatedAt: "desc" },
    });
  }

  async createVersion(
    mandateId: string,
    userId: string,
    input: MandateVersionInput,
    expectedVersion?: number,
  ) {
    validateVersionInput(input);

    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Mandate" WHERE id = ${mandateId} FOR UPDATE`;

      const mandate = await tx.mandate.findFirst({ where: { id: mandateId, userId } });
      if (!mandate) {
        throw new DatabaseError("NOT_FOUND", "Mandate was not found for this user.");
      }
      if (expectedVersion !== undefined && mandate.version !== expectedVersion) {
        throw new DatabaseError("CONFLICT", "Mandate version is stale.");
      }
      if (mandate.status === MandateStatus.REVOKED) {
        throw new DatabaseError("INVALID_STATE", "A revoked mandate cannot receive a new version.");
      }

      const versionNumber = mandate.version + 1;
      const version = await tx.mandateVersion.create({
        data: { mandateId, ...versionSnapshotData(input, versionNumber) },
      });

      if (input.rules?.length) {
        await tx.mandateRule.createMany({
          data: input.rules.map((rule) => ({
            mandateId,
            mandateVersionId: version.id,
            ruleType: rule.ruleType,
            operator: rule.operator,
            value: rule.value,
          })),
        });
      }
      await tx.auditEvent.create({
        data: {
          userId,
          eventType: AuditEventType.MANDATE_UPDATED,
          entityType: AuditEntityType.MANDATE,
          entityId: mandate.id,
          payload: {
            mandateId: mandate.id,
            mandateVersionId: version.id,
            version: versionNumber,
            changedFields: [
              "title",
              "currency",
              "spending_limits",
              "validity_window",
              "canonical_rules",
              "rules",
            ],
          },
        },
      });

      return tx.mandate.update({
        where: { id: mandateId },
        data: { ...versionData(input, versionNumber), activeVersionId: version.id },
        include: mandateWithVersion,
      });
    });
  }

  async activate(mandateId: string, userId: string, expectedVersion?: number) {
    return this.transitionStatus(
      mandateId,
      userId,
      MandateStatus.ACTIVE,
      [MandateStatus.DRAFT, MandateStatus.PAUSED],
      expectedVersion,
    );
  }

  async pause(mandateId: string, userId: string, expectedVersion?: number) {
    return this.db.$transaction((tx) =>
      this.transitionStatusInTransaction(
        tx,
        mandateId,
        userId,
        MandateStatus.PAUSED,
        [MandateStatus.ACTIVE],
        expectedVersion,
      ),
    );
  }

  async pauseInTransaction(
    tx: Prisma.TransactionClient,
    mandateId: string,
    userId: string,
    expectedVersion?: number,
  ) {
    return this.transitionStatusInTransaction(
      tx,
      mandateId,
      userId,
      MandateStatus.PAUSED,
      [MandateStatus.ACTIVE],
      expectedVersion,
    );
  }

  async resume(mandateId: string, userId: string, expectedVersion?: number) {
    return this.db.$transaction((tx) =>
      this.transitionStatusInTransaction(
        tx,
        mandateId,
        userId,
        MandateStatus.ACTIVE,
        [MandateStatus.PAUSED],
        expectedVersion,
      ),
    );
  }

  async revoke(mandateId: string, userId: string, expectedVersion?: number) {
    return this.db.$transaction((tx) =>
      this.transitionStatusInTransaction(
        tx,
        mandateId,
        userId,
        MandateStatus.REVOKED,
        [MandateStatus.DRAFT, MandateStatus.ACTIVE, MandateStatus.PAUSED, MandateStatus.EXPIRED],
        expectedVersion,
      ),
    );
  }

  async revokeInTransaction(
    tx: Prisma.TransactionClient,
    mandateId: string,
    userId: string,
    expectedVersion?: number,
  ) {
    return this.transitionStatusInTransaction(
      tx,
      mandateId,
      userId,
      MandateStatus.REVOKED,
      [MandateStatus.DRAFT, MandateStatus.ACTIVE, MandateStatus.PAUSED, MandateStatus.EXPIRED],
      expectedVersion,
    );
  }

  private async transitionStatus(
    mandateId: string,
    userId: string,
    next: MandateStatus,
    allowedCurrent: readonly MandateStatus[],
    expectedVersion?: number,
  ) {
    return this.db.$transaction((tx) =>
      this.transitionStatusInTransaction(
        tx,
        mandateId,
        userId,
        next,
        allowedCurrent,
        expectedVersion,
      ),
    );
  }

  private async transitionStatusInTransaction(
    tx: Prisma.TransactionClient,
    mandateId: string,
    userId: string,
    next: MandateStatus,
    allowedCurrent: readonly MandateStatus[],
    expectedVersion?: number,
  ) {
    await tx.$queryRaw`SELECT id FROM "Mandate" WHERE id = ${mandateId} FOR UPDATE`;
    const mandate = await tx.mandate.findFirst({ where: { id: mandateId, userId } });
    if (!mandate) {
      throw new DatabaseError("NOT_FOUND", "Mandate was not found for this user.");
    }
    if (expectedVersion !== undefined && mandate.version !== expectedVersion) {
      throw new DatabaseError("CONFLICT", "Mandate version is stale.");
    }
    if (mandate.status === next) {
      const current = await tx.mandate.findUnique({
        where: { id: mandate.id },
        include: mandateWithVersion,
      });
      if (!current) throw new DatabaseError("NOT_FOUND", "Mandate was not found for this user.");
      return current;
    }
    if (!allowedCurrent.includes(mandate.status)) {
      throw new DatabaseError(
        "INVALID_STATE",
        `Cannot move mandate from ${mandate.status} to ${next}.`,
      );
    }
    if (
      next === MandateStatus.ACTIVE &&
      (new Date() < mandate.startsAt || new Date() >= mandate.expiresAt)
    ) {
      throw new DatabaseError("INVALID_STATE", "Mandate is outside its validity window.");
    }
    const eventType =
      next === MandateStatus.ACTIVE && mandate.status === MandateStatus.PAUSED
        ? AuditEventType.MANDATE_RESUMED
        : next === MandateStatus.ACTIVE
          ? AuditEventType.MANDATE_ACTIVATED
          : next === MandateStatus.PAUSED
            ? AuditEventType.MANDATE_PAUSED
            : next === MandateStatus.REVOKED
              ? AuditEventType.MANDATE_REVOKED
              : next === MandateStatus.EXPIRED
                ? AuditEventType.MANDATE_EXPIRED
                : AuditEventType.MANDATE_UPDATED;
    await tx.auditEvent.create({
      data: {
        userId,
        eventType,
        entityType: AuditEntityType.MANDATE,
        entityId: mandate.id,
        payload: {
          mandateId: mandate.id,
          from: mandate.status,
          to: next,
        },
      },
    });
    return tx.mandate.update({
      where: { id: mandate.id },
      data: { status: next },
      include: mandateWithVersion,
    });
  }
}
