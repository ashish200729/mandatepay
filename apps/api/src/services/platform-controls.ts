import {
  PLATFORM_CONTROL_MESSAGES,
  resolvePlatformControls,
  type PlatformControlCode,
} from "@mandatepay/shared";

type SettingReader = {
  platformSetting: {
    findMany(args: {
      select: { key: true; valueJson: true };
    }): Promise<ReadonlyArray<{ key: string; valueJson: unknown }>>;
  };
};

export class PlatformControlDenied extends Error {
  readonly httpStatus = 403;
  constructor(readonly code: PlatformControlCode) {
    super(PLATFORM_CONTROL_MESSAGES[code]);
    this.name = "PlatformControlDenied";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function readPlatformControls(db: SettingReader) {
  const rows = await db.platformSetting.findMany({ select: { key: true, valueJson: true } });
  return resolvePlatformControls(rows);
}

/** Route gates deny the action when the store cannot be read. */
export async function readPlatformControlsFailClosed(db: SettingReader) {
  try {
    return await readPlatformControls(db);
  } catch {
    return resolvePlatformControls(null);
  }
}

async function controls(db: SettingReader) {
  return readPlatformControlsFailClosed(db);
}

export async function assertNewCheckout(db: SettingReader) {
  const current = await controls(db);
  if (current["platform.maintenanceMode"]) throw new PlatformControlDenied("MAINTENANCE");
  if (!current["payments.checkoutEnabled"]) throw new PlatformControlDenied("CHECKOUT_DISABLED");
}

export async function assertCustomerCapture(db: SettingReader) {
  const current = await controls(db);
  if (current["platform.maintenanceMode"]) throw new PlatformControlDenied("MAINTENANCE");
}

export async function assertNewRefund(db: SettingReader) {
  const current = await controls(db);
  if (current["platform.maintenanceMode"]) throw new PlatformControlDenied("MAINTENANCE");
  if (!current["payments.refundsEnabled"]) throw new PlatformControlDenied("REFUNDS_DISABLED");
}

export async function assertRegistrationOpen(db: SettingReader) {
  const current = await controls(db);
  if (!current["platform.registrationEnabled"])
    throw new PlatformControlDenied("REGISTRATION_DISABLED");
}

export async function assertShoppingAgentOpen(db: SettingReader) {
  const current = await controls(db);
  if (!current["agent.enabled"]) throw new PlatformControlDenied("AGENT_DISABLED");
}

export async function agentProposalsOpen(db: SettingReader) {
  return (await controls(db))["agent.proposalCreationEnabled"];
}

export async function assertDiscoverySource(db: SettingReader, source: "demo" | "channel3") {
  const current = await controls(db);
  if (source === "demo" && !current["discovery.demoCatalogEnabled"])
    throw new PlatformControlDenied("DEMO_CATALOG_DISABLED");
  if (source === "channel3" && !current["discovery.channel3Enabled"])
    throw new PlatformControlDenied("CHANNEL3_DISABLED");
}

export async function webhookProcessingOpen(db: SettingReader) {
  return (await controls(db))["workers.webhookProcessingEnabled"];
}

export async function platformAutonomyEnabled(db: SettingReader) {
  return (await readPlatformControls(db))["payments.autonomyEnabledGlobally"];
}
