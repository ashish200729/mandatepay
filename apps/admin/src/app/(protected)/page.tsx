import { PageHeader } from "@/components/admin/page-header";
import { MetricCard } from "@/components/admin/metric-card";
import { EventTimeline } from "@/components/admin/timeline";
import { EntityLink } from "@/components/admin/entity-link";
import { adminApi } from "@/lib/admin-fetch";
import { formatUsd } from "@/lib/money";
import {
  parseAdminDetail,
  parseAdminList,
  parseAdminOverview,
  parseAdminActivityEvent,
  type AdminMetric,
} from "@mandatepay/shared";
import Link from "next/link";

function metricValue(metric: AdminMetric | undefined) {
  if (!metric || metric.availability === "unavailable" || metric.value === null) return null;
  return metric.unit === "minor" ? formatUsd(metric.value) : metric.value;
}

export default async function OverviewPage() {
  const [overviewResponse, activityResponse] = await Promise.all([
    adminApi("/api/admin/overview"),
    adminApi("/api/admin/overview/activity?limit=20"),
  ]);
  const overview = parseAdminDetail(overviewResponse.json, parseAdminOverview);
  const activity = parseAdminList(activityResponse.json, parseAdminActivityEvent);
  const metrics = overview?.data.metrics ?? {};
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
  return (
    <>
      <PageHeader
        title="Operations overview"
        description="Read-only snapshot of MandatePay operations. Unavailable telemetry is shown as an em dash, never as zero."
        breadcrumbs={[{ label: "Overview" }]}
      />
      {!overview ? (
        <p role="alert">The overview could not be loaded. Try again shortly.</p>
      ) : (
        <>
          <section aria-label="Key metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {cards.map((card) => {
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
                events={(activity?.data ?? []).map((event) => ({
                  id: event.id,
                  title: event.title,
                  at: event.at,
                  status: event.status,
                  description: event.highRisk
                    ? "High-risk operational event."
                    : "Operational event.",
                  detail: event.href ? (
                    <EntityLink resource={event.href.resource} id={event.href.id} />
                  ) : undefined,
                }))}
                emptyDescription="No recent operational events in this window."
              />
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
                  className="flex min-h-11 items-center rounded-xl border bg-card px-4 text-sm underline-offset-4 hover:underline"
                >
                  {label}
                </Link>
              ))}
            </nav>
          </section>
        </>
      )}
    </>
  );
}
