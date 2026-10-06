import {
  PLATFORM_SETTING_DEFAULTS,
  PLATFORM_SETTING_FAIL_CLOSED,
  parseStoredPlatformBoolean,
  type PlatformSettingKey,
} from "@mandatepay/shared";
import { Prisma } from "../generated/prisma/client.js";
import { DatabaseError } from "../errors.js";

type SettingClient = Prisma.TransactionClient;

export type StoredPlatformSetting = {
  key: string;
  valueJson: unknown;
  version: number;
  updatedByAdminId: string;
  updatedAt: Date;
};

export type ComparedPlatformSetting = {
  changed: boolean;
  value: boolean;
  version: number;
  updatedByAdminId: string;
  updatedAt: Date;
  previousValue: boolean;
  previousVersion: number;
};

function currentBoolean(key: PlatformSettingKey, value: unknown) {
  return parseStoredPlatformBoolean(key, value) ?? PLATFORM_SETTING_FAIL_CLOSED[key];
}

/** Locked compare-and-set. Version 0 means the registry default and no stored row. */
export async function compareAndSetPlatformSetting(
  tx: SettingClient,
  input: {
    key: PlatformSettingKey;
    expectedVersion: number;
    value: boolean;
    adminId: string;
  },
): Promise<ComparedPlatformSetting> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"platform-setting:" + input.key}))`;
  const rows = await tx.$queryRaw<StoredPlatformSetting[]>`
    SELECT "key", "valueJson", "version", "updatedByAdminId", "updatedAt"
    FROM "PlatformSetting"
    WHERE "key" = ${input.key}
    FOR UPDATE
  `;
  const current = rows[0];
  const version = current?.version ?? 0;
  if (version !== input.expectedVersion) {
    throw new DatabaseError("CONFLICT", "Platform setting version changed.");
  }
  const previousValue = current
    ? currentBoolean(input.key, current.valueJson)
    : PLATFORM_SETTING_DEFAULTS[input.key];
  if (current && previousValue === input.value) {
    return {
      changed: false,
      value: previousValue,
      version,
      updatedByAdminId: current.updatedByAdminId,
      updatedAt: current.updatedAt,
      previousValue,
      previousVersion: version,
    };
  }
  if (!current) {
    const created = await tx.platformSetting.create({
      data: {
        key: input.key,
        valueJson: input.value,
        version: 1,
        updatedByAdminId: input.adminId,
      },
    });
    return {
      changed: true,
      value: input.value,
      version: created.version,
      updatedByAdminId: created.updatedByAdminId,
      updatedAt: created.updatedAt,
      previousValue,
      previousVersion: 0,
    };
  }
  const updated = await tx.platformSetting.update({
    where: { key: input.key },
    data: {
      valueJson: input.value,
      version: { increment: 1 },
      updatedByAdminId: input.adminId,
    },
  });
  return {
    changed: true,
    value: input.value,
    version: updated.version,
    updatedByAdminId: updated.updatedByAdminId,
    updatedAt: updated.updatedAt,
    previousValue,
    previousVersion: version,
  };
}
