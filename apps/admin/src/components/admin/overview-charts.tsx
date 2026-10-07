import type { AdminMetric } from "@mandatepay/shared";
import Link from "next/link";
import { EmptyState } from "./states";
import { StatusBadge } from "./status-badge";
import { chartRecordHref, CHART_RANGE_HREFS } from "@/lib/chart-hrefs";

function labelFor(key: string) {
  return key.replaceAll("_", " ").replaceAll(":", " · ");
}

export function OverviewChartCard({
  title,
  metricKey,
  metric,
  range,
  kind,
  formatValue,
}: {
  title: string;
  metricKey: string;
  metric: AdminMetric | undefined;
  range: { from: string; to: string };
  kind: "columns" | "bars" | "funnel";
  formatValue?: (value: number) => string;
}) {
  const format = formatValue ?? String;
  const recordsHref = CHART_RANGE_HREFS[metricKey]?.(range);
  if (!metric || metric.availability === "unavailable") {
    return (
      <article className="rounded-2xl border bg-card p-5">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="mt-3">
          <StatusBadge status="UNKNOWN" label="Unavailable" />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {metric?.reason ?? metric?.definition ?? "Definition unavailable."}
        </p>
      </article>
    );
  }
  const items = (metric.series ?? []).map((row) => ({
    ...row,
    label: labelFor(row.key),
    href: chartRecordHref(metricKey, row.key, range),
    display: format(row.value),
  }));
  const peak = Math.max(0, ...items.map((row) => row.value));
  return (
    <article className="rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {recordsHref ? (
          <Link
            href={recordsHref}
            className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
          >
            View records
          </Link>
        ) : null}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{metric.definition}</p>
      {items.length === 0 || peak === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="No data in range"
            description="Nothing matched this metric in the selected UTC window."
          />
        </div>
      ) : kind === "columns" ? (
        <ColumnChart title={title} items={items} peak={peak} />
      ) : (
        <BarChart items={items} peak={peak} funnel={kind === "funnel"} />
      )}
    </article>
  );
}

function ColumnChart({
  title,
  items,
  peak,
}: {
  title: string;
  items: readonly {
    key: string;
    label: string;
    value: number;
    display: string;
    href: string | null;
  }[];
  peak: number;
}) {
  const first = items[0];
  const last = items.at(-1);
  return (
    <div className="mt-4">
      <div
        role="img"
        aria-label={`${title} from ${first?.label ?? ""} to ${last?.label ?? ""}`}
        className="flex h-40 items-end gap-px overflow-x-auto"
      >
        {items.map((item) => {
          const height = Math.max(item.value > 0 ? 6 : 0, Math.round((item.value / peak) * 100));
          const bar = (
            <span
              className="block w-full min-w-[4px] rounded-t bg-[color:var(--admin-chart,#C4A574)]"
              style={{ height: `${height}%`, backgroundColor: "#C4A574" }}
            />
          );
          return item.href ? (
            <Link
              key={item.key}
              href={item.href}
              title={`${item.label}: ${item.display}`}
              className="flex h-full min-w-[6px] flex-1 flex-col justify-end"
            >
              {bar}
              <span className="sr-only">
                {item.label}: {item.display}
              </span>
            </Link>
          ) : (
            <span
              key={item.key}
              title={`${item.label}: ${item.display}`}
              className="flex h-full min-w-[6px] flex-1 flex-col justify-end"
            >
              {bar}
            </span>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground">
        <span>{first?.label}</span>
        <span>{last?.label}</span>
      </div>
    </div>
  );
}

function BarChart({
  items,
  peak,
  funnel,
}: {
  items: readonly {
    key: string;
    label: string;
    value: number;
    display: string;
    href: string | null;
  }[];
  peak: number;
  funnel: boolean;
}) {
  return (
    <ul className="mt-4 space-y-2">
      {items.map((item) => {
        const width = peak === 0 ? 0 : Math.round((item.value / peak) * 100);
        const inner = (
          <>
            <span className="flex min-h-11 items-center justify-between gap-3 text-sm">
              <span>{item.label}</span>
              <span className="tabular-nums">{item.display}</span>
            </span>
            <span className="block h-2 rounded-full bg-secondary">
              <span
                className="block h-2 rounded-full"
                style={{
                  width: `${funnel ? Math.max(width, item.value > 0 ? 8 : 0) : width}%`,
                  backgroundColor: "#C4A574",
                }}
              />
            </span>
          </>
        );
        return (
          <li key={item.key}>
            {item.href ? (
              <Link href={item.href} className="block rounded-xl hover:bg-secondary/80">
                {inner}
              </Link>
            ) : (
              inner
            )}
          </li>
        );
      })}
    </ul>
  );
}
