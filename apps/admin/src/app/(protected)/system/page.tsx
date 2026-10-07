import { PageHeader } from "@/components/admin/page-header";
import { HealthIndicator, StatusBadge } from "@/components/admin/status-badge";
import { HealthComponentCard, ParseAlert } from "@/components/admin/health-card";
import { formatUtcDate } from "@/components/admin/timeline";
import { adminApi } from "@/lib/admin-fetch";
import {
  parseAdminDetail,
  parseAdminIntegrationHealth,
  parseAdminSystemHealth,
  parseAdminWorkerHealth,
  workerLiveness,
  type AdminWorkerHealth,
} from "@mandatepay/shared";

const environments = {
  development: "Development",
  test: "Test",
  production: "Production",
  unknown: "Unknown",
} as const;

export default async function SystemHealthPage() {
  const [healthResponse, workersResponse, integrationsResponse] = await Promise.all([
    adminApi("/api/admin/system/health"),
    adminApi("/api/admin/system/workers"),
    adminApi("/api/admin/system/integrations"),
  ]);
  const health = parseAdminDetail(healthResponse.json, parseAdminSystemHealth);
  const workers = parseAdminDetail(workersResponse.json, parseAdminWorkerHealth);
  const integrations = parseAdminDetail(integrationsResponse.json, parseAdminIntegrationHealth);
  const shown = new Set(health?.data.components.map((component) => component.id) ?? []);
  const extraIntegrations =
    integrations?.data.components.filter((component) => !shown.has(component.id)) ?? [];

  return (
    <>
      <PageHeader
        title="System health"
        description="Readiness of the API, database, webhook worker, and integrations. Probes report status only."
        breadcrumbs={[{ label: "Overview", href: "/" }, { label: "System health" }]}
      />
      <div className="space-y-10">
        {!health ? (
          <ParseAlert message="System health could not be loaded." href="/system" />
        ) : (
          <section aria-label="Overall status" className="rounded-2xl border bg-card p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-sm font-medium">Overall</h2>
              <HealthIndicator status={health.data.overall} />
            </div>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Environment</dt>
                <dd className="mt-1 text-sm">{environments[health.data.environment]}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">API commit</dt>
                <dd className="mt-1 break-all text-sm">
                  {health.data.build.commitSha ?? "Not recorded"}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Build version</dt>
                <dd className="mt-1 break-all text-sm">
                  {health.data.build.version ?? "Not recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Observed</dt>
                <dd className="mt-1 text-sm">{formatUtcDate(health.data.observedAt)}</dd>
              </div>
            </dl>
          </section>
        )}

        {health ? (
          <section aria-label="Subsystems">
            <h2 className="mb-4 text-lg font-medium">Subsystems</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {health.data.components.map((component) => (
                <HealthComponentCard key={component.id} component={component} />
              ))}
            </div>
          </section>
        ) : null}

        <section aria-label="Webhook worker">
          <h2 className="mb-4 text-lg font-medium">Webhook worker</h2>
          {!workers ? (
            <ParseAlert message="Worker health could not be loaded." href="/system" />
          ) : workers.data.workers.length === 0 ? (
            <article className="rounded-2xl border bg-card p-5">
              <HealthIndicator status="unknown" />
              <p className="mt-3 text-sm">Liveness is unknown. No worker run has been recorded.</p>
            </article>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <p className="text-sm text-muted-foreground sm:col-span-2">
                A heartbeat older than {workers.data.staleAfterSeconds} seconds is stale.
              </p>
              {workers.data.workers.map((worker) => (
                <WorkerCard
                  key={worker.worker}
                  worker={worker}
                  observedAt={workers.data.observedAt}
                />
              ))}
            </div>
          )}
        </section>

        <section aria-label="Integrations">
          <h2 className="mb-4 text-lg font-medium">Integrations</h2>
          {!integrations ? (
            <ParseAlert message="Integration health could not be loaded." href="/system" />
          ) : (
            <div className="space-y-4">
              <div className="rounded-2xl border bg-card p-5 text-sm leading-relaxed">
                <p>{integrations.data.note}</p>
                <p className="mt-2">Probes do not display credentials.</p>
              </div>
              {extraIntegrations.length > 0 ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {extraIntegrations.map((component) => (
                    <HealthComponentCard key={component.id} component={component} />
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function WorkerCard({
  worker,
  observedAt,
}: {
  worker: AdminWorkerHealth["workers"][number];
  observedAt: string;
}) {
  const noRun = worker.runId === null && worker.heartbeatAt === null && worker.outcome === null;
  const live = noRun
    ? {
        status: "unknown" as const,
        summary: "Liveness is unknown. No worker run has been recorded.",
      }
    : workerLiveness({
        heartbeatAt: worker.heartbeatAt ? new Date(worker.heartbeatAt) : null,
        outcome: worker.outcome,
        now: new Date(observedAt),
      });
  return (
    <article className="rounded-2xl border bg-card p-5 sm:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-sm font-medium">PayPal webhook recovery</h3>
        <HealthIndicator status={live.status} />
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{live.summary}</p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Last heartbeat</dt>
          <dd className="mt-1 text-sm">
            {worker.heartbeatAt ? formatUtcDate(worker.heartbeatAt) : "Not recorded"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Outcome</dt>
          <dd className="mt-1 text-sm">
            {worker.outcome ? (
              <StatusBadge status={worker.outcome} tone={workerOutcomeTone(worker.outcome)} />
            ) : (
              "Not recorded"
            )}
          </dd>
        </div>
        {worker.errorCode ? (
          <div>
            <dt className="text-xs text-muted-foreground">Error code</dt>
            <dd className="mt-1 text-sm">{worker.errorCode}</dd>
          </div>
        ) : null}
      </dl>
      {noRun ? (
        <p className="mt-4 text-sm">No batch has been recorded.</p>
      ) : (
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {(
            [
              ["Scanned", worker.counts.scanned],
              ["Claimed", worker.counts.claimed],
              ["Processed", worker.counts.processed],
              ["Ignored", worker.counts.ignored],
              ["Pending", worker.counts.pending],
              ["Exhausted", worker.counts.exhausted],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-sm tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

function workerOutcomeTone(outcome: NonNullable<AdminWorkerHealth["workers"][number]["outcome"]>) {
  if (outcome === "SUCCEEDED") return "success" as const;
  if (outcome === "FAILED") return "danger" as const;
  if (outcome === "RUNNING") return "info" as const;
  return "warning" as const;
}
