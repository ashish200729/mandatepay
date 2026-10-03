"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Clock3, LoaderCircle } from "lucide-react";
import { formatUtcDate } from "@/lib/mandates/money";
import { getAuditEvents } from "@/lib/analytics/client";
import type { AuditEvent } from "@/lib/analytics/types";

function eventDetail(event: AuditEvent) {
  const payload = event.payload;
  if (!payload) return null;
  const reasonCodes = Array.isArray(payload.reasonCodes)
    ? payload.reasonCodes.filter((code): code is string => typeof code === "string")
    : [];
  const transition =
    typeof payload.from === "string" && typeof payload.to === "string"
      ? `${payload.from} → ${payload.to}`
      : null;
  const decision = typeof payload.decision === "string" ? payload.decision : null;
  const version = typeof payload.version === "number" ? `Mandate version ${payload.version}` : null;
  return (
    [
      reasonCodes.length ? `Reasons: ${reasonCodes.join(", ")}` : null,
      transition,
      decision ? `Decision: ${decision}` : null,
      version,
    ]
      .filter(Boolean)
      .join(" · ") || null
  );
}

export function AuditTimeline({ entityId }: { entityId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEvents(await getAuditEvents(entityId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Audit history could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [entityId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-editorial text-2xl tracking-[-0.02em]">Audit timeline</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Persisted events for this record and its related decisions.
          </p>
        </div>
        <Clock3 size={20} className="text-muted-foreground" aria-hidden="true" />
      </div>
      {loading ? (
        <div className="mt-7 flex items-center text-sm text-muted-foreground" role="status">
          <LoaderCircle size={16} className="mr-2 animate-spin" aria-hidden="true" /> Loading audit
          history…
        </div>
      ) : error ? (
        <div className="mt-7 text-sm" role="alert">
          <p className="flex items-start gap-2">
            <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 font-medium underline underline-offset-4"
          >
            Try again
          </button>
        </div>
      ) : events.length ? (
        <ol className="mt-7 space-y-5">
          {events.map((event) => (
            <li key={event.id} className="relative border-l border-border pl-5">
              <span
                className="absolute -left-1.5 top-1.5 size-2.5 rounded-full bg-primary"
                aria-hidden="true"
              />
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{event.eventType.replaceAll("_", " ")}</p>
                <time className="text-xs text-muted-foreground">
                  {formatUtcDate(event.createdAt)}
                </time>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {event.entityType.replaceAll("_", " ")}
              </p>
              {eventDetail(event) ? (
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {eventDetail(event)}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-7 text-sm text-muted-foreground">
          No audit events were returned for this record yet.
        </p>
      )}
    </section>
  );
}
