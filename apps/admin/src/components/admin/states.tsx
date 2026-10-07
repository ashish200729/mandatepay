"use client";
import type { ReactNode } from "react";
import { Button } from "@mandatepay/ui/components/button";
import { AlertCircle, Inbox, RefreshCw } from "lucide-react";

export function EmptyState({
  title = "No records",
  description,
  action,
  embedded = false,
}: {
  title?: string;
  description: string;
  action?: ReactNode;
  embedded?: boolean;
}) {
  return (
    <div
      className={
        embedded ? "px-4 py-8 text-center" : "rounded-xl border bg-card px-6 py-12 text-center"
      }
    >
      <Inbox
        size={24}
        strokeWidth={1.4}
        aria-hidden="true"
        className="mx-auto mb-4 text-muted-foreground"
      />
      <h2 className="text-base font-medium">{title}</h2>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
export function ErrorState({
  title = "Could not load records",
  description = "Try again shortly.",
  onRetry,
  pending = false,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  pending?: boolean;
}) {
  return (
    <div
      role="alert"
      aria-label={title}
      className="rounded-xl border border-admin-danger-foreground/20 bg-card p-6"
    >
      <h2 className="flex items-center gap-2.5 font-medium">
        <AlertCircle size={18} aria-hidden="true" className="text-admin-danger-foreground" />
        {title}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      {onRetry && (
        <Button className="mt-4" variant="outline" onClick={onRetry} disabled={pending}>
          <RefreshCw size={15} aria-hidden="true" />
          {pending ? "Retrying…" : "Try again"}
        </Button>
      )}
    </div>
  );
}
export function LoadingSkeleton({
  label = "Loading records…",
  rows = 4,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div role="status" aria-busy="true" className="rounded-2xl border bg-card p-5">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="space-y-4">
        {Array.from({ length: Math.min(10, Math.max(1, rows)) }, (_, index) => (
          <div key={index} className="h-11 rounded-lg bg-secondary motion-safe:animate-pulse" />
        ))}
      </div>
    </div>
  );
}
