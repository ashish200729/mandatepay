import { StatusBadge } from "./status-badge";

export function MetricCard({
  label,
  value,
  description,
  availability = "available",
  compact = false,
}: {
  label: string;
  value: string | number | null;
  description: string;
  availability?: "available" | "unavailable";
  compact?: boolean;
}) {
  return (
    <article className={`min-w-0 bg-card p-5 ${compact ? "" : "rounded-xl border"}`}>
      <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
      <p
        className={`mt-2 break-words font-medium tracking-tight tabular-nums ${compact ? "text-2xl" : "text-3xl"}`}
      >
        {availability === "unavailable" || value === null ? "—" : value}
      </p>
      {(availability === "unavailable" || value === null) && (
        <div className="mt-2">
          <StatusBadge status="UNKNOWN" label="Unavailable" />
        </div>
      )}
      <p className="mt-3 text-xs leading-5 text-muted-foreground">{description}</p>
    </article>
  );
}
