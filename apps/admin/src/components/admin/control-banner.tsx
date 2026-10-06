import Link from "next/link";

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
      className={`mb-8 rounded-2xl border p-4 ${
        unavailable || restricted
          ? "bg-admin-warning text-admin-warning-foreground"
          : "bg-secondary"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Platform mode</h2>
          <p className="mt-1 max-w-3xl text-sm">{mode}</p>
        </div>
        <Link
          href="/settings"
          className="inline-flex min-h-11 items-center rounded-xl border bg-background px-4 text-sm text-foreground"
        >
          Review controls
        </Link>
      </div>
    </section>
  );
}
