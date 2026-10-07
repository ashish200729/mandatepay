import type { ReactNode } from "react";
import {
  buildAdminSummary,
  parseAdminAuditEvent,
  type AdminAuditEventDTO,
  type AdminAuditTarget,
} from "@mandatepay/shared";
import { StatusBadge } from "./status-badge";
import { EmptyState, ErrorState } from "./states";
import { ChevronDown } from "lucide-react";

export function formatUtcDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(date) + " UTC"
    : "Date unavailable";
}
export function JsonViewer({
  targetType,
  summary,
  label,
}: {
  targetType: AdminAuditTarget;
  summary: unknown;
  label: string;
}) {
  let safe;
  try {
    safe = buildAdminSummary(targetType, summary);
  } catch {
    safe = null;
  }
  return (
    <details className="group mt-3 rounded-lg border bg-card">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-xs font-medium hover:bg-secondary/40 [&::-webkit-details-marker]:hidden">
        {label}
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-secondary p-4 text-xs">
        {safe === null ? "No state summary" : JSON.stringify(safe, null, 2)}
      </pre>
    </details>
  );
}
export type TimelineEvent = {
  id: string;
  title: string;
  at: string;
  status: string;
  description: ReactNode;
  detail?: ReactNode;
};
export function EventTimeline({
  events,
  emptyDescription = "Recorded events will appear here.",
}: {
  events: readonly TimelineEvent[];
  emptyDescription?: string;
}) {
  if (!events.length) return <EmptyState title="No activity" description={emptyDescription} />;
  return (
    <ol className="rounded-xl border bg-card px-5 py-2 sm:px-6">
      {events.map((event) => (
        <li key={event.id} className="min-w-0 border-b py-5 last:border-b-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium">{event.title}</h3>
            <StatusBadge status={event.status} />
          </div>
          <time dateTime={event.at} className="mt-2 block text-xs text-muted-foreground">
            {formatUtcDate(event.at)}
          </time>
          <div className="mt-2 text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
            {event.description}
          </div>
          {event.detail}
        </li>
      ))}
    </ol>
  );
}
export function AuditTimeline({
  events,
  onRetry,
}: {
  events: readonly AdminAuditEventDTO[];
  onRetry?: () => void;
}) {
  // Reproject defensively rather than render raw summary objects from a caller.
  const safe = events
    .map(parseAdminAuditEvent)
    .filter((event): event is AdminAuditEventDTO => event !== null);
  if (safe.length !== events.length)
    return (
      <ErrorState
        title="Audit activity unavailable"
        description="Reload the current view to try again."
        onRetry={onRetry}
      />
    );
  return (
    <EventTimeline
      events={safe.map((event) => ({
        id: event.id,
        title: event.action
          .replace(/^ADMIN_/u, "")
          .toLowerCase()
          .replaceAll("_", " "),
        at: event.createdAt,
        status: event.result,
        description: (
          <>
            <p>{event.reason}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {event.targetType.toLowerCase().replaceAll("_", " ")} · {event.targetId}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {event.actorAdminId ? `Admin ${event.actorAdminId}` : "Unauthenticated attempt"}
            </p>
            {event.errorCode && (
              <p className="mt-1 text-xs">
                Outcome: {event.errorCode.toLowerCase().replaceAll("_", " ")}
              </p>
            )}
          </>
        ),
        detail: (
          <>
            <JsonViewer
              targetType={event.targetType}
              summary={event.beforeSummaryJson}
              label="Before state"
            />
            <JsonViewer
              targetType={event.targetType}
              summary={event.afterSummaryJson}
              label="After state"
            />
          </>
        ),
      }))}
    />
  );
}
