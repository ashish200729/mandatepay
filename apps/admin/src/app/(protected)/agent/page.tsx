import Link from "next/link";
import { PageHeader } from "@/components/admin/page-header";
import { MetricCard } from "@/components/admin/metric-card";
import { EmptyState } from "@/components/admin/states";
import { EntityLink } from "@/components/admin/entity-link";
import { OutcomeBadge, ParseAlert, errorClassLabel } from "@/components/admin/health-card";
import { formatUtcDate } from "@/components/admin/timeline";
import { adminApi } from "@/lib/admin-fetch";
import {
  AGENT_ERROR_CLASSES,
  AGENT_RUN_OUTCOMES,
  parseAdminAgentMetrics,
  parseAdminAgentRun,
  parseAdminDetail,
  parseAdminList,
} from "@mandatepay/shared";

const errorFilters = [
  ["TIMEOUT", "Timeout"],
  ["PROVIDER_UNAVAILABLE", "Provider unavailable"],
  ["INVALID_RESPONSE", "Invalid response"],
  ["TOOL_FAILURE", "Tool failure"],
  ["RATE_LIMITED", "Rate limited"],
  ["UNKNOWN", "Unknown"],
] as const;

export default async function AgentActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const outcome = allowed(single(query.outcome), AGENT_RUN_OUTCOMES);
  const errorClass = allowed(single(query.errorClass), AGENT_ERROR_CLASSES);
  const [metricsResponse, runsResponse] = await Promise.all([
    adminApi("/api/admin/agent/metrics"),
    adminApi(runsPath(outcome, errorClass)),
  ]);
  const metrics = parseAdminDetail(metricsResponse.json, parseAdminAgentMetrics);
  const runs = parseAdminList(runsResponse.json, parseAdminAgentRun);
  const pageHref = agentPath(outcome, errorClass);
  const cards = metrics
    ? [
        { label: "Requests", metric: metrics.data.requests },
        { label: "Successful runs", metric: metrics.data.successfulRuns },
        { label: "Failed runs", metric: metrics.data.failedRuns },
        { label: "Average latency (ms)", metric: metrics.data.latencyMs },
        { label: "Tool errors", metric: metrics.data.toolErrors },
        { label: "Refund drafts", metric: metrics.data.refundDrafts },
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Agent activity"
        description="Counts, timing, model ids, and tool names for shopping-agent runs."
        breadcrumbs={[{ label: "Overview", href: "/" }, { label: "Agent activity" }]}
      />
      <div className="mb-8 space-y-3">
        <nav aria-label="Outcome" className="flex flex-wrap gap-2">
          <FilterLink href={agentPath(undefined, errorClass)} active={!outcome} label="All" />
          <FilterLink
            href={agentPath("SUCCEEDED", errorClass)}
            active={outcome === "SUCCEEDED"}
            label="Succeeded"
          />
          <FilterLink
            href={agentPath("FAILED", errorClass)}
            active={outcome === "FAILED"}
            label="Failed"
          />
        </nav>
        <nav aria-label="Error class" className="flex flex-wrap gap-2">
          <FilterLink href={agentPath(outcome, undefined)} active={!errorClass} label="All" />
          {errorFilters.map(([value, label]) => (
            <FilterLink
              key={value}
              href={agentPath(outcome, value)}
              active={errorClass === value}
              label={label}
            />
          ))}
        </nav>
      </div>
      <section aria-label="Agent metrics" className="mb-10">
        <h2 className="mb-4 text-lg font-medium">Metrics</h2>
        {!metrics ? (
          <ParseAlert message="Agent metrics could not be loaded." href={pageHref} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
              <AgentMetricCard key={card.label} label={card.label} metric={card.metric} />
            ))}
          </div>
        )}
      </section>
      <section aria-label="Agent runs">
        <h2 className="mb-4 text-lg font-medium">Runs</h2>
        {!runs ? (
          <ParseAlert message="Agent runs could not be loaded." href={pageHref} />
        ) : runs.data.length === 0 ? (
          <EmptyState title="No agent runs" description="No runs match these filters." />
        ) : (
          <ul className="space-y-3">
            {runs.data.map((run) => (
              <li key={run.id} className="rounded-2xl border bg-card p-4 text-sm">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Link
                    href={`/agent/runs/${encodeURIComponent(run.id)}`}
                    className="inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline"
                  >
                    {formatUtcDate(run.startedAt)}
                  </Link>
                  <OutcomeBadge outcome={run.outcome} />
                  <span>{errorClassLabel(run.errorClass)}</span>
                  <span className="break-all">{run.modelId}</span>
                  <span>{run.durationMs === null ? "—" : `${run.durationMs} ms`}</span>
                  <span>
                    {run.tools.length} {run.tools.length === 1 ? "tool" : "tools"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4">
                  <span className="inline-flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">User</span>
                    <EntityLink resource="users" id={run.userId} />
                  </span>
                  {run.proposalId ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Proposal</span>
                      <EntityLink resource="proposals" id={run.proposalId} />
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function AgentMetricCard({
  label,
  metric,
}: {
  label: string;
  metric: {
    value: number | null;
    availability: "available" | "unavailable";
    reason: string | null;
    definition: string;
  };
}) {
  return (
    <MetricCard
      label={label}
      value={metric.availability === "unavailable" ? null : metric.value}
      availability={metric.availability}
      description={metric.reason ?? metric.definition}
    />
  );
}

function FilterLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-11 items-center rounded-xl border px-4 text-sm ${
        active ? "bg-admin-active font-medium" : "bg-card"
      }`}
    >
      {label}
    </Link>
  );
}

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

function allowed<T extends string>(value: string | undefined, options: readonly T[]) {
  return value && (options as readonly string[]).includes(value) ? (value as T) : undefined;
}

function agentPath(outcome?: string, errorClass?: string) {
  const params = new URLSearchParams();
  if (outcome) params.set("outcome", outcome);
  if (errorClass) params.set("errorClass", errorClass);
  const text = params.toString();
  return text ? `/agent?${text}` : "/agent";
}

function runsPath(outcome?: string, errorClass?: string) {
  const params = new URLSearchParams();
  params.set("limit", "50");
  if (outcome) params.set("outcome", outcome);
  if (errorClass) params.set("errorClass", errorClass);
  return `/api/admin/agent/runs?${params.toString()}`;
}
