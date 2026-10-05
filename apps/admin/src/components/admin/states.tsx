"use client";
import type { ReactNode } from "react";
import { Button } from "@mandatepay/ui/components/button";

export function EmptyState({
  title = "No records",
  description,
  action,
}: {
  title?: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border bg-card px-6 py-12 text-center">
      <h2 className="text-lg font-medium">{title}</h2>
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
    <div role="alert" aria-label={title} className="rounded-2xl border bg-card p-6">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      {onRetry && (
        <Button className="mt-4" variant="outline" onClick={onRetry} disabled={pending}>
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
