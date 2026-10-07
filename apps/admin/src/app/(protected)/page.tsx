import { ControlBanner } from "@/components/admin/control-banner";
import { PageHeader } from "@/components/admin/page-header";
import { MetricCard } from "@/components/admin/metric-card";
import { OverviewRangeSelector } from "@/components/admin/range-selector";
import { OverviewChartCard } from "@/components/admin/overview-charts";
import { EventTimeline } from "@/components/admin/timeline";
import { EntityLink } from "@/components/admin/entity-link";
import { HealthIndicator } from "@/components/admin/status-badge";
import { componentLabel } from "@/components/admin/health-card";
import { adminApi } from "@/lib/admin-fetch";
import { formatUsd } from "@/lib/money";
import { activityApiPath, overviewApiPath, readOverviewSearch } from "@/lib/overview-query";
import {
  parseAdminDetail,
  parseAdminList,
  parseAdminOverview,
  parseAdminActivityEvent,
  parseAdminPlatformSetting,
  parseAdminSystemHealth,
  describePlatformMode,
  PLATFORM_SETTING_DEFAULTS,
  restrictiveControlCount,
  type AdminMetric,
  type PlatformSettingKey,
} from "@mandatepay/shared";
import { AdminLink as Link } from "@/components/admin/link";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { ParseAlert } from "@/components/admin/health-card";
import { DisclosureSection } from "@/components/admin/disclosure-section";

function metricValue(metric: AdminMetric | undefined) {
  if (!metric || metric.availability === "unavailable" || metric.value === null) return null;
  return metric.unit === "minor" ? formatUsd(metric.value) : metric.value;
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsed = readOverviewSearch(await searchParams);
  const [overviewResponse, activityResponse, settingsResponse, healthResponse] = await Promise.all([
    adminApi(overviewApiPath(parsed.search)),
    adminApi(activityApiPath(parsed.search)),
    adminApi("/api/admin/settings"),
    adminApi("/api/admin/system/health"),
  ]);
  const overview = parseAdminDetail(overviewResponse.json, parseAdminOverview);
  const activity = parseAdminList(activityResponse.json, parseAdminActivityEvent);
  const settings = parseAdminList(settingsResponse.json, parseAdminPlatformSetting);
  const health = parseAdminDetail(healthResponse.json, parseAdminSystemHealth);
  const controls = settings
    ? (Object.fromEntries(settings.data.map((item) => [item.key, item.value])) as Record<
        PlatformSettingKey,
        boolean
      >)
    : null;
  const mode = controls
    ? describePlatformMode({ ...PLATFORM_SETTING_DEFAULTS, ...controls })
    : "Platform mode could not be loaded. Treat customer checkout, capture, and new refunds as unavailable until the controls load.";
  const metrics = overview?.data.metrics ?? {};
  const range = overview?.data.range;
  const cards: { key: string; label: string }[] = [
    { key: "totalUsers", label: "Total users" },
    { key: "verifiedUsers", label: "Verified users" },
    { key: "activeMandates", label: "Active mandates" },
    { key: "activeProposals", label: "Active proposals" },
    { key: "approvalRequiredProposals", label: "Approval required" },
    { key: "ordersCreated", label: "Orders created" },
    { key: "capturedPayments", label: "Captured payments" },
    { key: "paymentFailures", label: "Payment failures" },
    { key: "refundsMinor", label: "Refund total" },
    { key: "webhookFailures", label: "Webhook failures" },
    { key: "recoveryQueueDepth", label: "Recovery queue" },
    { key: "agentRequests", label: "Agent requests" },
    { key: "autonomousUsers", label: "Autonomous users" },
  ];
  const charts: {
    key: string;
    title: string;
    kind: "columns" | "bars" | "funnel";
    money?: boolean;
  }[] = [
    { key: "newUsersByDay", title: "User growth", kind: "columns" },
    { key: "capturedGrossByDay", title: "Payment volume", kind: "columns", money: true },
    { key: "refundsByDay", title: "Refund volume", kind: "columns", money: true },
    { key: "policyDistribution", title: "AgentGuard decisions", kind: "bars" },
    { key: "approvalFunnel", title: "Approval funnel", kind: "funnel" },
    { key: "checkoutFunnel", title: "Checkout funnel", kind: "funnel" },
    { key: "webhookDeliveriesByDay", title: "Webhook deliveries", kind: "columns" },
    { key: "webhookDeliveryOutcomes", title: "Webhook health", kind: "bars" },
    { key: "webhookStatusCounts", title: "Inbox status", kind: "bars" },
    { key: "topErrorCategories", title: "Top error categories", kind: "bars" },
    { key: "mandateStatusDistribution", title: "Mandate status", kind: "bars" },
    { key: "agentRunsByDay", title: "Agent runs", kind: "columns" },
    { key: "agentErrorClasses", title: "Agent error classes", kind: "bars" },
  ];
  const events = (activity?.data ?? []).map((event) => ({
    id: event.id,
    title: event.title,
    at: event.at,
    status: event.status,
    description: event.highRisk ? "High-risk operational event." : "Operational event.",
    detail: event.href ? (
      <EntityLink resource={event.href.resource} id={event.href.id} />
    ) : undefined,
  }));
  return (
    <>
      <PageHeader
        title="Operations overview"
        description="Account activity, purchasing decisions and payment operations in one place."
        breadcrumbs={[{ label: "Overview" }]}
      />
      {health?.data.build.commitSha ? (
        <p className="-mt-4 mb-7 text-sm text-muted-foreground">
          API commit {health.data.build.commitSha}
        </p>
      ) : null}
      {parsed.error ? (
        <p role="alert" className="mb-6 text-sm">
          {parsed.error} Showing the default 30-day window.
        </p>
      ) : null}
      {overview ? (
        <OverviewRangeSelector
          from={overview.data.range.from}
          to={overview.data.range.to}
          asOf={overview.data.asOf}
        />
      ) : null}
      <ControlBanner
        mode={mode}
        restricted={controls ? restrictiveControlCount(controls) > 0 : true}
        unavailable={!controls}
      />
      {overview && (
        <section aria-label="Key metrics" className="mb-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {cards
            .filter((card) =>
              ["totalUsers", "activeMandates", "capturedPayments", "refundsMinor"].includes(
                card.key,
              ),
            )
            .map((card) => {
              const metric = metrics[card.key];
              return (
                <MetricCard
                  key={card.key}
                  label={card.label}
                  value={metricValue(metric)}
                  availability={metric?.availability ?? "unavailable"}
                  description={metric?.reason ?? metric?.definition ?? "Definition unavailable."}
                />
              );
            })}
        </section>
      )}
      <section aria-label="Subsystem warnings" className="mb-8">
        <details className="group border-y">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 py-2 [&::-webkit-details-marker]:hidden">
            <span className="text-sm font-medium">System status</span>
            <span className="flex items-center gap-3">
              {health ? (
                <HealthIndicator status={health.data.overall} />
              ) : (
                <span className="text-sm text-admin-danger-foreground">Unavailable</span>
              )}
              <ChevronDown
                size={16}
                aria-hidden="true"
                className="shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
              />
            </span>
          </summary>
          <div className="pb-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-medium">System status</h2>
              <Link
                href="/system"
                className="inline-flex min-h-11 items-center gap-1.5 rounded text-xs font-medium underline"
              >
                View system health
                <ArrowUpRight size={14} aria-hidden="true" />
              </Link>
            </div>
            {!health ? (
              <div role="alert" className="rounded-2xl border bg-card p-5 text-sm">
                <p>System health could not be loaded.</p>
                <Link
                  href="/system"
                  className="mt-3 inline-flex min-h-11 items-center underline underline-offset-4"
                >
                  View system health
                </Link>
              </div>
            ) : health.data.components.every((component) => component.status === "ready") ? (
              <div className="rounded-2xl border bg-card p-5 text-sm">
                <p>
                  Checked subsystems are ready.{" "}
                  <Link href="/system" className="underline underline-offset-4">
                    View system health
                  </Link>
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border bg-card divide-y">
                {health.data.components
                  .filter((component) => component.status !== "ready")
                  .map((component) => (
                    <article
                      key={component.id}
                      className="grid gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-[11rem_minmax(0,1fr)]"
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <h2 className="text-sm font-medium">{componentLabel(component.id)}</h2>
                        <HealthIndicator status={component.status} />
                      </div>
                      <p className="text-sm leading-6 text-muted-foreground">{component.summary}</p>
                    </article>
                  ))}
              </div>
            )}
          </div>
        </details>
      </section>
      {!overview ? (
        <ParseAlert message="The overview could not be loaded. Try again shortly." href="/" />
      ) : (
        <>
          <section aria-label="Operational metrics">
            <DisclosureSection title="More metrics">
              <div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 xl:grid-cols-3">
                {cards
                  .filter(
                    (card) =>
                      ![
                        "totalUsers",
                        "activeMandates",
                        "capturedPayments",
                        "refundsMinor",
                      ].includes(card.key),
                  )
                  .map((card) => {
                    const metric = metrics[card.key];
                    return (
                      <MetricCard
                        key={card.key}
                        label={card.label}
                        value={metricValue(metric)}
                        availability={metric?.availability ?? "unavailable"}
                        description={
                          metric?.reason ?? metric?.definition ?? "Definition unavailable."
                        }
                        compact
                      />
                    );
                  })}
              </div>
            </DisclosureSection>
          </section>
          <section aria-label="Operational charts" className="mt-10 space-y-9">
            <div>
              <h2 className="mb-4 text-base font-medium">Trends</h2>
              <div className="grid gap-5 lg:grid-cols-2">
                {charts
                  .filter((chart) => ["capturedGrossByDay", "newUsersByDay"].includes(chart.key))
                  .map((chart) => (
                    <OverviewChartCard
                      key={chart.key}
                      title={chart.title}
                      metricKey={chart.key}
                      metric={metrics[chart.key]}
                      range={range!}
                      kind={chart.kind}
                      formatValue={chart.money ? formatUsd : undefined}
                    />
                  ))}
              </div>
            </div>
            {[
              {
                title: "Purchasing and payments",
                keys: [
                  "refundsByDay",
                  "policyDistribution",
                  "approvalFunnel",
                  "checkoutFunnel",
                  "mandateStatusDistribution",
                ],
              },
              {
                title: "Customers and agents",
                keys: ["agentRunsByDay", "agentErrorClasses"],
              },
              {
                title: "Webhooks and recovery",
                keys: [
                  "webhookDeliveriesByDay",
                  "webhookDeliveryOutcomes",
                  "webhookStatusCounts",
                  "topErrorCategories",
                ],
              },
            ].map((group) => (
              <DisclosureSection key={group.title} title={group.title}>
                <div className="grid gap-5 lg:grid-cols-2">
                  {charts
                    .filter((chart) => group.keys.includes(chart.key))
                    .map((chart) => (
                      <OverviewChartCard
                        key={chart.key}
                        title={chart.title}
                        metricKey={chart.key}
                        metric={metrics[chart.key]}
                        range={range!}
                        kind={chart.kind}
                        formatValue={chart.money ? formatUsd : undefined}
                      />
                    ))}
                </div>
              </DisclosureSection>
            ))}
          </section>
          {overview.data.warnings.length > 0 && (
            <ul className="mt-6 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {overview.data.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <section className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
            <div>
              <h2 className="mb-4 text-lg font-medium">Recent activity</h2>
              <EventTimeline
                events={events.slice(0, 5)}
                emptyDescription="No recent operational events in this window."
              />
              {events.length > 5 && (
                <DisclosureSection title="More activity" className="mt-4">
                  <EventTimeline events={events.slice(5)} />
                </DisclosureSection>
              )}
            </div>
            <nav aria-label="Quick links" className="space-y-3">
              <h2 className="text-lg font-medium">Quick links</h2>
              {(
                [
                  ["/payments?status=FAILED", "Failed payments"],
                  ["/approvals?decision=PENDING", "Pending approvals"],
                  ["/webhooks?status=FAILED", "Webhook failures"],
                  ["/refunds", "Recent refunds"],
                  ["/audit", "Full admin audit"],
                ] as const
              ).map(([href, label]) => (
                <Link
                  key={href}
                  href={href}
                  className="flex min-h-12 items-center justify-between gap-3 rounded-lg border bg-card px-4 text-sm transition-colors hover:bg-secondary motion-reduce:transition-none"
                >
                  {label}
                  <ArrowUpRight size={15} aria-hidden="true" />
                </Link>
              ))}
            </nav>
          </section>
        </>
      )}
    </>
  );
}
