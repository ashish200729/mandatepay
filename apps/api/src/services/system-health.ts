import { DEMO_CATALOG } from "@mandatepay/channel3";
import {
  ObservabilityRepository,
  PaymentSource,
  PaymentStatus,
  type ObservabilityClient,
} from "@mandatepay/database";
import {
  DATABASE_SLOW_MS,
  PROBE_CACHE_MS,
  aggregateHealth,
  resolvePlatformControls,
  safeBuild,
  workerLiveness,
  type AdminHealthComponent,
  type AdminIntegrationHealth,
  type AdminSystemHealth,
  type AdminWorkerHealth,
  type AdminWorkerName,
  type HealthStatus,
} from "@mandatepay/shared";

type WorkerSnapshot = AdminWorkerHealth["workers"][number];

/**
 * An autonomous (Vault) payment whose PayPal create-order outcome is unknown
 * has no order id. The reconcile worker replays it while that is safe; one
 * still unbound after this age is held (saved method removed, switches off,
 * replay window elapsed or PayPal unreachable) and needs an operator, because
 * its reservation must not be released while PayPal may have charged it.
 */
export const UNBOUND_VAULT_ATTENTION_MS = 30 * 60_000;

export function unboundVaultPaymentWhere(now: Date) {
  return {
    status: PaymentStatus.CAPTURE_PENDING,
    paymentSource: PaymentSource.VAULT,
    paypalOrderId: null,
    isSample: false,
    updatedAt: { lte: new Date(now.getTime() - UNBOUND_VAULT_ATTENTION_MS) },
  };
}

export async function countUnboundVaultPayments(database: ObservabilityClient, now: Date) {
  return database.payment.count({ where: unboundVaultPaymentWhere(now) });
}
type HeartbeatRow = Awaited<ReturnType<ObservabilityRepository["latestWorker"]>>["row"];

function emptyWorker(worker: AdminWorkerName): WorkerSnapshot {
  return {
    worker,
    status: "unknown",
    runId: null,
    startedAt: null,
    heartbeatAt: null,
    completedAt: null,
    outcome: null,
    errorCode: null,
    counts: { scanned: 0, claimed: 0, processed: 0, ignored: 0, pending: 0, exhausted: 0 },
  };
}

/**
 * One scheduled job's liveness from its latest heartbeat row: missing is
 * unknown; older than 15 minutes, failed or skipped is degraded.
 */
export function workerHealth(input: {
  worker: AdminWorkerName;
  id: "worker" | "reconcileWorker";
  row: HeartbeatRow;
  enabled: boolean | null;
  now: Date;
}): { component: AdminHealthComponent; snapshot: WorkerSnapshot } {
  const { row } = input;
  const liveness = workerLiveness({
    heartbeatAt: row?.heartbeatAt ?? null,
    outcome: row?.outcome ?? null,
    now: input.now,
    worker: input.worker,
  });
  return {
    component: component({
      id: input.id,
      status: liveness.status,
      configured: true,
      enabled: input.enabled,
      summary: liveness.summary,
      lastSuccessAt: row?.outcome === "SUCCEEDED" && row.completedAt ? iso(row.completedAt) : null,
    }),
    snapshot: row
      ? {
          worker: input.worker,
          status: liveness.status,
          runId: row.runId,
          startedAt: iso(row.startedAt),
          heartbeatAt: iso(row.heartbeatAt),
          completedAt: row.completedAt ? iso(row.completedAt) : null,
          outcome: row.outcome,
          errorCode: row.errorCode === "WORKER_FAILED" ? "WORKER_FAILED" : null,
          counts: {
            scanned: row.scanned,
            claimed: row.claimed,
            processed: row.processed,
            ignored: row.ignored,
            pending: row.pending,
            exhausted: row.exhausted,
          },
        }
      : emptyWorker(input.worker),
  };
}

export type IntegrationProbe = {
  status: "ready" | "degraded" | "unavailable";
  code: string;
  latencyMs: number;
};

const probeCodes = new Set([
  "PAYPAL_REACHABLE",
  "CHANNEL3_REACHABLE",
  "DEMO_CATALOG_READY",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_ABORTED",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_REQUEST_FAILED",
  "AUTHENTICATION_FAILED",
  "MALFORMED_RESPONSE",
  "INVALID_RESPONSE",
  "MISSING_API_KEY",
  "PROBE_FAILED",
  "PROBE_UNSUPPORTED",
]);

const cache = new Map<
  string,
  { at: number; result?: IntegrationProbe; pending?: Promise<IntegrationProbe> }
>();

export function resetIntegrationProbeCache() {
  cache.clear();
}

function iso(value: Date) {
  return value.toISOString();
}

function environmentOf(value: string): AdminSystemHealth["environment"] {
  if (value === "development" || value === "test" || value === "production") return value;
  return "unknown";
}

function safeCode(code: string) {
  return probeCodes.has(code) ? code : "PROBE_FAILED";
}

function component(
  input: Omit<
    AdminHealthComponent,
    "latencyMs" | "lastSuccessAt" | "backlog" | "failed" | "retrying"
  > &
    Partial<
      Pick<AdminHealthComponent, "latencyMs" | "lastSuccessAt" | "backlog" | "failed" | "retrying">
    >,
): AdminHealthComponent {
  return {
    latencyMs: null,
    lastSuccessAt: null,
    backlog: null,
    failed: null,
    retrying: null,
    ...input,
  };
}

async function cachedProbe(
  key: string,
  load: () => Promise<IntegrationProbe>,
): Promise<IntegrationProbe> {
  const current = cache.get(key);
  const now = Date.now();
  if (current?.result && now - current.at < PROBE_CACHE_MS) return current.result;
  if (current?.pending) return current.pending;
  const pending = load()
    .then((result) => {
      const safe = {
        status: result.status,
        code: safeCode(result.code),
        latencyMs: Math.min(120_000, Math.max(0, Math.round(result.latencyMs))),
      };
      cache.set(key, { at: Date.now(), result: safe });
      return safe;
    })
    .catch(() => {
      const failed: IntegrationProbe = {
        status: "unavailable",
        code: "PROBE_FAILED",
        latencyMs: 0,
      };
      cache.set(key, { at: Date.now(), result: failed });
      return failed;
    });
  cache.set(key, { at: now, pending });
  return pending;
}

function probeSummary(kind: string, probe: IntegrationProbe) {
  if (probe.status === "ready") return `${kind} responded to a bounded status probe.`;
  if (probe.code === "UPSTREAM_TIMEOUT" || probe.code === "UPSTREAM_ABORTED") {
    return `${kind} did not respond before the probe deadline.`;
  }
  if (probe.code === "UPSTREAM_UNAVAILABLE")
    return `${kind} is rate limited or temporarily unavailable.`;
  if (probe.code === "AUTHENTICATION_FAILED") return `${kind} rejected the configured credentials.`;
  if (probe.status === "degraded") return `${kind} is degraded.`;
  return `${kind} could not be reached.`;
}

export async function readSystemHealth(input: {
  database: ObservabilityClient;
  environment: string;
  paypalConfigured: boolean;
  channel3Configured: boolean;
  probePaypal?: () => Promise<IntegrationProbe>;
  probeChannel3?: () => Promise<IntegrationProbe>;
  now?: Date;
}): Promise<{
  health: AdminSystemHealth;
  workers: AdminWorkerHealth;
  integrations: AdminIntegrationHealth;
}> {
  const now = input.now ?? new Date();
  const observedAt = iso(now);
  const build = safeBuild({
    commitSha:
      process.env.MANDATEPAY_COMMIT_SHA ?? process.env.RENDER_GIT_COMMIT ?? process.env.GITHUB_SHA,
    version: process.env.MANDATEPAY_BUILD_VERSION,
  });
  const api = component({
    id: "api",
    status: "ready",
    configured: null,
    enabled: null,
    summary: "The API process answered this readiness request.",
    lastSuccessAt: observedAt,
  });

  let database: AdminHealthComponent;
  let worker: AdminHealthComponent;
  let reconcileWorker: AdminHealthComponent;
  let webhooks: AdminHealthComponent;
  let agent: AdminHealthComponent;
  let checkoutEnabled: boolean | null = null;
  let channel3Enabled: boolean | null = null;
  let demoEnabled: boolean | null = null;
  let agentEnabled: boolean | null = null;
  let lastReconcileAt: Date | null = null;
  let workerSnapshots: WorkerSnapshot[] = [
    emptyWorker("paypal-webhook-recovery"),
    emptyWorker("paypal-payment-reconcile"),
  ];
  const repository = new ObservabilityRepository(input.database);

  try {
    const latencyMs = await repository.pingDatabase();
    const slow = latencyMs >= DATABASE_SLOW_MS;
    database = component({
      id: "database",
      status: slow ? "degraded" : "ready",
      configured: null,
      enabled: null,
      summary: slow
        ? "PostgreSQL answered, but the check was slower than one second."
        : "PostgreSQL answered a connectivity check.",
      latencyMs,
      lastSuccessAt: observedAt,
    });
    const [latest, latestReconcile, operations, latestRun, reconcile, rows, unboundVault] =
      await Promise.all([
        repository.latestWorker(now),
        repository.latestWorker(now, "paypal-payment-reconcile"),
        repository.webhookOperations(now),
        repository.latestAgentRun(),
        repository.lastSuccessfulReconcile(),
        repository.platformControlRows(),
        countUnboundVaultPayments(input.database, now),
      ]);
    const resolved = resolvePlatformControls(rows);
    checkoutEnabled = resolved["payments.checkoutEnabled"];
    channel3Enabled = resolved["discovery.channel3Enabled"];
    demoEnabled = resolved["discovery.demoCatalogEnabled"];
    agentEnabled = resolved["agent.enabled"];
    lastReconcileAt = reconcile;
    const webhookWorker = workerHealth({
      worker: "paypal-webhook-recovery",
      id: "worker",
      row: latest.row,
      enabled: resolved["workers.webhookProcessingEnabled"],
      now,
    });
    const paymentReconcile = workerHealth({
      worker: "paypal-payment-reconcile",
      id: "reconcileWorker",
      row: latestReconcile.row,
      enabled: null,
      now,
    });
    worker = webhookWorker.component;
    reconcileWorker = { ...paymentReconcile.component, backlog: unboundVault };
    if (unboundVault > 0) {
      // Held money needs an operator even while the worker itself is healthy.
      if (reconcileWorker.status === "ready") reconcileWorker.status = "degraded";
      reconcileWorker.summary =
        `${reconcileWorker.summary} ${unboundVault} autonomous payment(s) with an unknown PayPal outcome are held with their reservations and need review.`.slice(
          0,
          300,
        );
    }
    workerSnapshots = [webhookWorker.snapshot, paymentReconcile.snapshot];
    const pressure =
      operations.failed +
      operations.retrying +
      operations.backlog +
      operations.staleLeases +
      operations.exhausted;
    webhooks = component({
      id: "webhooks",
      status: pressure > 0 ? "degraded" : "ready",
      configured: null,
      enabled: resolved["workers.webhookProcessingEnabled"],
      summary:
        pressure > 0
          ? `${operations.failed} failed, ${operations.retrying} scheduled to retry, and ${operations.backlog} eligible now.`
          : "No failed, retrying, or due webhook work.",
      lastSuccessAt: operations.lastProcessedAt ? iso(operations.lastProcessedAt) : null,
      backlog: operations.backlog,
      failed: operations.failed,
      retrying: operations.retrying,
    });
    agent = component({
      id: "agent",
      status: latestRun ? (latestRun.outcome === "FAILED" ? "degraded" : "ready") : "unknown",
      configured: null,
      enabled: agentEnabled,
      summary: latestRun
        ? latestRun.outcome === "FAILED"
          ? `The latest agent run failed with ${latestRun.errorClass}.`
          : "The latest recorded agent run succeeded."
        : "No agent runs have been recorded.",
      lastSuccessAt:
        latestRun?.outcome === "SUCCEEDED" && latestRun.completedAt
          ? iso(latestRun.completedAt)
          : null,
    });
  } catch {
    const unread = "This check was not read because the database is unavailable.";
    database = component({
      id: "database",
      status: "unavailable",
      configured: null,
      enabled: null,
      summary: "PostgreSQL did not answer a connectivity check.",
    });
    worker = component({
      id: "worker",
      status: "unknown",
      configured: true,
      enabled: null,
      summary: unread,
    });
    reconcileWorker = component({
      id: "reconcileWorker",
      status: "unknown",
      configured: true,
      enabled: null,
      summary: unread,
    });
    webhooks = component({
      id: "webhooks",
      status: "unknown",
      configured: null,
      enabled: null,
      summary: unread,
    });
    agent = component({
      id: "agent",
      status: "unknown",
      configured: null,
      enabled: null,
      summary: unread,
    });
  }

  const paypal = await integrationComponent({
    id: "paypal",
    label: "PayPal Sandbox",
    configured: input.paypalConfigured,
    enabled: checkoutEnabled,
    missing:
      "PayPal Sandbox is not configured. A missing key is not reported as healthy or unhealthy.",
    unsupported: "PayPal Sandbox is configured, but this process cannot run a live probe.",
    probe: input.probePaypal,
    cacheKey: "paypal",
    now,
  });
  const channel3 = await integrationComponent({
    id: "channel3",
    label: "Channel3",
    configured: input.channel3Configured,
    enabled: channel3Enabled,
    missing: "Channel3 is not configured. A missing key is not reported as healthy or unhealthy.",
    unsupported: "Channel3 is configured, but this process cannot run a live probe.",
    probe: input.probeChannel3,
    cacheKey: "channel3",
    now,
  });
  const demo = demoCatalogComponent(demoEnabled, now);
  if (lastReconcileAt) {
    paypal.summary =
      `${paypal.summary} Last successful admin reconciliation: ${iso(lastReconcileAt)}.`.slice(
        0,
        300,
      );
  }
  const components = [
    api,
    database,
    worker,
    reconcileWorker,
    webhooks,
    paypal,
    channel3,
    demo,
    agent,
  ];
  const overall = aggregateHealth(components);
  const note = "Provider probes are read-only, cached, and do not include credentials or payloads.";
  return {
    health: {
      observedAt,
      environment: environmentOf(input.environment),
      build,
      overall,
      components,
    },
    workers: { observedAt, staleAfterSeconds: 900, workers: workerSnapshots },
    integrations: {
      observedAt,
      note,
      components: [paypal, channel3, demo],
    },
  };
}

async function integrationComponent(input: {
  id: "paypal" | "channel3";
  label: string;
  configured: boolean;
  enabled: boolean | null;
  missing: string;
  unsupported: string;
  probe?: () => Promise<IntegrationProbe>;
  cacheKey: string;
  now: Date;
}): Promise<AdminHealthComponent> {
  if (!input.configured) {
    return component({
      id: input.id,
      status: "unknown",
      configured: false,
      enabled: input.enabled,
      summary: input.missing,
    });
  }
  if (!input.probe) {
    return component({
      id: input.id,
      status: "unknown",
      configured: true,
      enabled: input.enabled,
      summary: input.unsupported,
    });
  }
  const probe = await cachedProbe(input.cacheKey, input.probe);
  const status: HealthStatus = probe.status;
  return component({
    id: input.id,
    status,
    configured: true,
    enabled: input.enabled,
    summary: probeSummary(input.label, probe),
    latencyMs: probe.latencyMs,
    lastSuccessAt: status === "ready" ? iso(input.now) : null,
  });
}

function demoCatalogComponent(enabled: boolean | null, now: Date): AdminHealthComponent {
  const loaded = Array.isArray(DEMO_CATALOG) && DEMO_CATALOG.length > 0;
  return component({
    id: "demoCatalog",
    status: loaded ? "ready" : "unavailable",
    configured: true,
    enabled,
    summary: loaded
      ? enabled === false
        ? "The in-process Demo Catalog is loaded. The Demo Catalog switch is off."
        : "The in-process Demo Catalog is loaded."
      : "The in-process Demo Catalog has no products.",
    lastSuccessAt: loaded ? iso(now) : null,
  });
}
