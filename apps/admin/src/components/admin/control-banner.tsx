import { AdminLink as Link } from "./link";
import { ArrowUpRight, ShieldCheck } from "lucide-react";

export function ControlBanner({
  mode,
  restricted,
  unavailable = false,
}: {
  mode: string;
  restricted: boolean;
  unavailable?: boolean;
}) {
  return (
    <section
      aria-label="Current platform mode"
      className={`mb-6 rounded-xl border p-4 ${
        unavailable || restricted
          ? "bg-admin-warning text-admin-warning-foreground"
          : "bg-secondary"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck size={16} aria-hidden="true" />
            Platform mode
          </h2>
          <p className="mt-2 max-w-3xl text-xs leading-5">
            {unavailable || restricted
              ? mode
              : "Normal operation. No platform controls are restricting access."}
          </p>
        </div>
        <Link
          href="/settings"
          className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-xs font-medium text-foreground underline underline-offset-4 hover:bg-card"
        >
          Review controls
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
