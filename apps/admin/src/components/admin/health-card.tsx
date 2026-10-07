import { AdminLink as Link } from "./link";
import type { AdminHealthComponent } from "@mandatepay/shared";
import { HealthIndicator, StatusBadge, type StatusTone } from "./status-badge";
import { formatUtcDate } from "./timeline";
import { AlertCircle, RefreshCw } from "lucide-react";

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
    <article className="min-w-0 rounded-xl border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-base font-medium">{componentLabel(component.id)}</h3>
        <HealthIndicator status={component.status} />
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{component.summary}</p>
      {facts.length > 0 ? (
        <details className="mt-3 border-t pt-1">
          <summary className="inline-flex min-h-11 cursor-pointer items-center rounded text-xs text-muted-foreground underline decoration-border">
            Service details
          </summary>
          <dl className="grid gap-4 pb-1 pt-2 sm:grid-cols-2">
            {facts.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-words text-sm tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </article>
  );
}

export function ParseAlert({ message, href }: { message: string; href: string }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-admin-danger-foreground/20 bg-card p-5 text-sm"
    >
      <p className="flex gap-2.5 leading-6">
        <AlertCircle
          size={18}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-admin-danger-foreground"
        />
        <span>{message}</span>
      </p>
      <Link
        href={href}
        className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg border px-4 font-medium hover:bg-secondary"
      >
        <RefreshCw size={15} aria-hidden="true" />
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
