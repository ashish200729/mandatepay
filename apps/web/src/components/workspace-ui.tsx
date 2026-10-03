import { Check, ChevronRight, CircleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@mandatepay/ui/lib/utils";

export const workspaceField =
  "h-11 w-full min-w-0 rounded-lg border border-border bg-card px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60";

export function WorkspaceCollectionToolbar({
  query,
  setQuery,
  status,
  setStatus,
  statuses,
  label,
  children,
}: {
  query: string;
  setQuery: (value: string) => void;
  status: string;
  setStatus: (value: string) => void;
  statuses: string[];
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="min-w-0 flex-1 basis-48">
        <span className="sr-only">{label}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={label}
          className={workspaceField}
        />
      </label>
      <label className="w-full min-w-0 sm:w-44">
        <span className="sr-only">Filter status</span>
        <select
          value={status}
          onChange={(event) => setStatus(event.currentTarget.value)}
          className={workspaceField}
        >
          <option value="">All statuses</option>
          {statuses.map((value) => (
            <option key={value} value={value}>
              {value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      {children}
    </div>
  );
}

export function WorkspaceStatus({ value }: { value: string }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-md px-2.5 py-1 text-xs font-medium leading-5",
        ["ACTIVE", "ALLOW", "COMPLETED", "AUTHORIZED"].includes(value)
          ? "bg-secondary text-foreground"
          : ["AWAITING_APPROVAL", "REQUIRE_APPROVAL", "PAUSED", "PENDING"].includes(value)
            ? "bg-sand text-foreground"
            : "bg-secondary text-muted-foreground",
      )}
    >
      {value.replaceAll("_", " ")}
    </span>
  );
}

export function WorkspaceLoading({ label }: { label: string }) {
  return (
    <div role="status" className="space-y-4">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((key) => (
        <div
          key={key}
          aria-hidden="true"
          className="space-y-3 rounded-xl border border-border bg-card p-6"
        >
          <div className="h-4 w-48 max-w-full rounded bg-secondary motion-safe:animate-pulse" />
          <div className="h-3 w-80 max-w-full rounded bg-secondary" />
        </div>
      ))}
    </div>
  );
}

export function WorkspaceNotice({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-secondary/70 px-4 py-3 text-sm leading-6"
    >
      <CircleAlert size={17} className="mt-1 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

export function WorkspaceEmpty({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-border bg-card px-5 py-10 text-center">
      <Icon size={24} className="text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
      <h2 className="mt-4 font-editorial text-2xl tracking-[-0.02em]">{title}</h2>
      <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      {children ? <div className="mt-5">{children}</div> : null}
    </section>
  );
}

export function WorkspaceSteps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol
      aria-label="Progress"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border pb-5 text-xs sm:text-sm"
    >
      {steps.map((step, index) => (
        <li
          key={step}
          aria-current={current === index ? "step" : undefined}
          className={cn(
            "flex items-center gap-2",
            index <= current ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "flex size-6 items-center justify-center rounded-full text-xs",
              index <= current ? "bg-sand" : "bg-secondary",
            )}
          >
            {index < current ? <Check size={12} aria-hidden="true" /> : index + 1}
          </span>
          {step}
          {index < steps.length - 1 ? (
            <ChevronRight size={12} className="ml-1 text-muted-foreground" aria-hidden="true" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}
