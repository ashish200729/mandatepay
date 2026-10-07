import Link from "next/link";
import type { AdminHealthComponent } from "@mandatepay/shared";
import { HealthIndicator, StatusBadge, type StatusTone } from "./status-badge";
import { formatUtcDate } from "./timeline";

const labels: Record<AdminHealthComponent["id"], string> = {
  api: "API",
  database: "Database",
  worker: "Webhook worker",
  webhooks: "Webhooks",
  paypal: "PayPal Sandbox",
  channel3: "Channel3",
  demoCatalog: "Demo Catalog",
  agent: "Shopping agent",
};

export function componentLabel(id: AdminHealthComponent["id"]) {
  return labels[id];
}

export function HealthComponentCard({ component }: { component: AdminHealthComponent }) {
  const facts = [
    component.latencyMs !== null ? ["Latency", `${component.latencyMs} ms`] : null,
    component.lastSuccessAt !== null
      ? ["Last success", formatUtcDate(component.lastSuccessAt)]
      : null,
    component.backlog !== null ? ["Backlog", String(component.backlog)] : null,
    component.failed !== null ? ["Failed", String(component.failed)] : null,
    component.retrying !== null ? ["Retrying", String(component.retrying)] : null,
    component.configured !== null ? ["Configured", component.configured ? "Yes" : "No"] : null,
    component.enabled !== null ? ["Enabled", component.enabled ? "Yes" : "No"] : null,
  ].filter((item): item is [string, string] => item !== null);
  return (
    <article className="rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-sm font-medium">{componentLabel(component.id)}</h3>
        <HealthIndicator status={component.status} />
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{component.summary}</p>
      {facts.length > 0 ? (
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 break-words text-sm">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </article>
  );
}

export function ParseAlert({ message, href }: { message: string; href: string }) {
  return (
    <div role="alert" className="rounded-2xl border bg-card p-5 text-sm">
      <p>{message}</p>
      <Link href={href} className="mt-3 inline-flex min-h-11 items-center rounded-xl border px-4">
        Reload
      </Link>
    </div>
  );
}

export function outcomeTone(outcome: "SUCCEEDED" | "FAILED"): StatusTone {
  return outcome === "SUCCEEDED" ? "success" : "danger";
}

export function OutcomeBadge({ outcome }: { outcome: "SUCCEEDED" | "FAILED" }) {
  return <StatusBadge status={outcome} tone={outcomeTone(outcome)} />;
}

export function errorClassLabel(value: string) {
  if (value === "NONE") return "None";
  return value.toLowerCase().replaceAll("_", " ");
}
