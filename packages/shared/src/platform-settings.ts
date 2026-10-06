import { z } from "zod";
import {
  ADMIN_SETTING_KEYS,
  AdminReasonSchema,
  AdminTraceIdSchema,
  type AdminAuditAction,
} from "./admin-audit.js";

export type PlatformSettingKey = (typeof ADMIN_SETTING_KEYS)[number];

/** Operating defaults when an administrator has not stored a row yet. */
export const PLATFORM_SETTING_DEFAULTS = {
  "platform.maintenanceMode": false,
  "platform.registrationEnabled": true,
  "agent.enabled": true,
  "agent.proposalCreationEnabled": true,
  "discovery.demoCatalogEnabled": true,
  "discovery.channel3Enabled": true,
  "payments.checkoutEnabled": true,
  "payments.refundsEnabled": true,
  "payments.autonomyEnabledGlobally": true,
  "workers.webhookProcessingEnabled": true,
} as const satisfies Record<PlatformSettingKey, boolean>;

/**
 * Effective value when the setting store cannot be read or a stored value is
 * not a boolean. Webhook processing stays on unless an administrator stored false,
 * so a failed read does not drop provider events.
 */
export const PLATFORM_SETTING_FAIL_CLOSED = {
  "platform.maintenanceMode": true,
  "platform.registrationEnabled": false,
  "agent.enabled": false,
  "agent.proposalCreationEnabled": false,
  "discovery.demoCatalogEnabled": false,
  "discovery.channel3Enabled": false,
  "payments.checkoutEnabled": false,
  "payments.refundsEnabled": false,
  "payments.autonomyEnabledGlobally": false,
  "workers.webhookProcessingEnabled": true,
} as const satisfies Record<PlatformSettingKey, boolean>;

export const CRITICAL_PLATFORM_SETTING_KEYS = [
  "platform.maintenanceMode",
  "payments.autonomyEnabledGlobally",
  "payments.checkoutEnabled",
  "payments.refundsEnabled",
  "workers.webhookProcessingEnabled",
] as const satisfies readonly PlatformSettingKey[];

export const PLATFORM_SETTING_GROUPS = ["Financial", "Shopping", "Operations"] as const;

const details = {
  "platform.maintenanceMode": {
    group: "Operations",
    title: "Maintenance mode",
    description:
      "Blocks customer checkout, capture, and new refunds. Health checks, administration, and webhook ingestion stay available.",
  },
  "platform.registrationEnabled": {
    group: "Operations",
    title: "Registration",
    description: "Allows new customer accounts to be created.",
  },
  "agent.enabled": {
    group: "Shopping",
    title: "Shopping agent",
    description: "Allows the shopping assistant chat.",
  },
  "agent.proposalCreationEnabled": {
    group: "Shopping",
    title: "Proposals from the agent",
    description: "Allows the shopping assistant to create purchase proposals.",
  },
  "discovery.demoCatalogEnabled": {
    group: "Shopping",
    title: "Demo Catalog",
    description: "Allows illustrative Demo Catalog product search.",
  },
  "discovery.channel3Enabled": {
    group: "Shopping",
    title: "Channel3 discovery",
    description: "Allows external Channel3 product discovery. Demo Catalog is a separate switch.",
  },
  "payments.checkoutEnabled": {
    group: "Financial",
    title: "Checkout",
    description:
      "Allows new PayPal order creation. Existing payment reconciliation and webhooks continue.",
  },
  "payments.refundsEnabled": {
    group: "Financial",
    title: "Refund initiation",
    description: "Allows new refunds. Refund status checks continue.",
  },
  "payments.autonomyEnabledGlobally": {
    group: "Financial",
    title: "Global autonomy",
    description:
      "Allows autonomous execution when a customer and mandate also allow it. Turning this off requires approval and leaves the manual approval path available.",
  },
  "workers.webhookProcessingEnabled": {
    group: "Operations",
    title: "Webhook processing",
    description:
      "Allows the recovery worker to process verified webhook events. Ingestion still records deliveries when this is off.",
  },
} as const satisfies Record<
  PlatformSettingKey,
  { group: (typeof PLATFORM_SETTING_GROUPS)[number]; title: string; description: string }
>;

const shortLabel: Record<PlatformSettingKey, string> = {
  "platform.maintenanceMode": "maintenance",
  "platform.registrationEnabled": "registration",
  "agent.enabled": "shopping agent",
  "agent.proposalCreationEnabled": "agent proposals",
  "discovery.demoCatalogEnabled": "demo catalog",
  "discovery.channel3Enabled": "channel3",
  "payments.checkoutEnabled": "checkout",
  "payments.refundsEnabled": "refunds",
  "payments.autonomyEnabledGlobally": "global autonomy",
  "workers.webhookProcessingEnabled": "webhook processing",
};

export const PLATFORM_CONTROL_MESSAGES = {
  MAINTENANCE: "MandatePay is in maintenance. This action is temporarily unavailable.",
  REGISTRATION_DISABLED: "New account registration is temporarily unavailable.",
  AGENT_DISABLED: "The shopping agent is temporarily unavailable.",
  AGENT_PROPOSALS_DISABLED: "The shopping agent cannot create purchase proposals right now.",
  DEMO_CATALOG_DISABLED: "The Demo Catalog is temporarily unavailable.",
  CHANNEL3_DISABLED: "Channel3 product discovery is temporarily unavailable.",
  CHECKOUT_DISABLED: "Checkout is temporarily unavailable. You can still view existing payments.",
  REFUNDS_DISABLED: "New refunds are temporarily unavailable. You can still check refund status.",
} as const;
export type PlatformControlCode = keyof typeof PLATFORM_CONTROL_MESSAGES;

export const AGENT_PROPOSAL_CALLER_HEADER = "x-mandatepay-agent";
export const AGENT_PROPOSAL_CALLER_VALUE = "proposal";

const utc = z.iso.datetime({ offset: false });
export const AdminPlatformSettingSchema = z
  .object({
    key: z.enum(ADMIN_SETTING_KEYS),
    value: z.boolean(),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updatedByAdminId: z.uuid().nullable(),
    updatedAt: utc.nullable(),
    critical: z.boolean(),
    group: z.enum(PLATFORM_SETTING_GROUPS),
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(300),
  })
  .strict();
export type AdminPlatformSetting = z.infer<typeof AdminPlatformSettingSchema>;

export const AdminPlatformSettingMutationSchema = z
  .object({
    value: z.boolean(),
    expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reason: AdminReasonSchema,
    confirmation: z.literal(true),
    requestKey: AdminTraceIdSchema,
    typedConfirmation: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type AdminPlatformSettingMutation = z.infer<typeof AdminPlatformSettingMutationSchema>;

export function isPlatformSettingKey(value: string): value is PlatformSettingKey {
  return (ADMIN_SETTING_KEYS as readonly string[]).includes(value);
}

export function isCriticalPlatformSetting(key: PlatformSettingKey) {
  return (CRITICAL_PLATFORM_SETTING_KEYS as readonly string[]).includes(key);
}

export function platformSettingAuditAction(key: PlatformSettingKey): AdminAuditAction {
  return key === "platform.maintenanceMode"
    ? "ADMIN_MAINTENANCE_MODE_CHANGED"
    : "ADMIN_FEATURE_FLAG_CHANGED";
}

export function parseStoredPlatformBoolean(
  key: PlatformSettingKey,
  value: unknown,
): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** `null` rows mean the store could not be read. Invalid JSON uses the fail-closed value. */
export function resolvePlatformControls(
  rows: readonly { key: string; valueJson: unknown }[] | null,
): Record<PlatformSettingKey, boolean> {
  if (rows === null) return { ...PLATFORM_SETTING_FAIL_CLOSED };
  const controls: Record<PlatformSettingKey, boolean> = { ...PLATFORM_SETTING_DEFAULTS };
  for (const row of rows) {
    if (!isPlatformSettingKey(row.key)) continue;
    const parsed = parseStoredPlatformBoolean(row.key, row.valueJson);
    controls[row.key] = parsed === null ? PLATFORM_SETTING_FAIL_CLOSED[row.key] : parsed;
  }
  return controls;
}

export function restrictiveControlCount(controls: Record<PlatformSettingKey, boolean>) {
  return ADMIN_SETTING_KEYS.filter((key) => controls[key] !== PLATFORM_SETTING_DEFAULTS[key])
    .length;
}

export function describePlatformMode(controls: Record<PlatformSettingKey, boolean>) {
  const restricted = ADMIN_SETTING_KEYS.filter(
    (key) => controls[key] !== PLATFORM_SETTING_DEFAULTS[key],
  );
  if (restricted.length === 0) {
    return "Normal operation. Maintenance is off. Checkout, refunds, autonomy, the shopping agent, discovery, registration, and webhook processing are on.";
  }
  const parts = restricted.map((key) => `${shortLabel[key]} is ${controls[key] ? "on" : "off"}`);
  return `Restricted platform mode: ${parts.join(", ")}.`;
}

export function presentPlatformSetting(
  key: PlatformSettingKey,
  stored: {
    valueJson: unknown;
    version: number;
    updatedByAdminId: string;
    updatedAt: Date;
  } | null,
): AdminPlatformSetting {
  const detail = details[key];
  const parsed = stored ? parseStoredPlatformBoolean(key, stored.valueJson) : null;
  return AdminPlatformSettingSchema.parse({
    key,
    value: stored ? (parsed ?? PLATFORM_SETTING_FAIL_CLOSED[key]) : PLATFORM_SETTING_DEFAULTS[key],
    version: stored?.version ?? 0,
    updatedByAdminId: stored?.updatedByAdminId ?? null,
    updatedAt: stored ? stored.updatedAt.toISOString() : null,
    critical: isCriticalPlatformSetting(key),
    group: detail.group,
    title: detail.title,
    description: detail.description,
  });
}

export function parseAdminPlatformSetting(value: unknown) {
  const parsed = AdminPlatformSettingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
