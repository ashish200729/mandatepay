import { StatusBadge } from "./status-badge";

export function MetricCard({
  label,
  value,
  description,
  availability = "available",
}: {
  label: string;
  value: string | number | null;
  description: string;
  availability?: "available" | "unavailable";
}) {
  return (
    <article className="min-w-0 rounded-2xl border bg-card p-5">
      <h2 className="text-sm font-medium">{label}</h2>
      <p className="mt-3 break-words text-3xl font-medium tabular-nums">
        {availability === "unavailable" || value === null ? "—" : value}
      </p>
      {(availability === "unavailable" || value === null) && (
        <div className="mt-2">
          <StatusBadge status="UNKNOWN" label="Unavailable" />
        </div>
      )}
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{description}</p>
    </article>
  );
}
