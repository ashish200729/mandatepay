"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, LoaderCircle, Plus, ShieldCheck } from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { listMandates } from "@/lib/mandates/client";
import { formatUsdLabel, formatUtcDate } from "@/lib/mandates/money";
import type { MandateDetail } from "@/lib/mandates/types";

function statusClass(status: string) {
  if (status === "ACTIVE") return "bg-primary text-primary-foreground";
  if (status === "PAUSED") return "bg-sand text-foreground";
  if (status === "REVOKED") return "bg-secondary text-muted-foreground";
  return "bg-secondary text-muted-foreground";
}

function MandateCard({ mandate }: { mandate: MandateDetail }) {
  return (
    <Link
      href={`/mandates/${mandate.id}`}
      className="group block rounded-2xl border border-border bg-card p-5 transition-[border-color,box-shadow] hover:border-foreground/30 hover:shadow-[0_12px_32px_rgba(27,20,14,0.07)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-reduce:transition-none sm:p-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sand">
            <ShieldCheck size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-editorial text-2xl tracking-[-0.02em] group-hover:underline group-hover:underline-offset-4">
              {mandate.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{mandate.rules.productIntent}</p>
          </div>
        </div>
        <span
          className={cn("rounded-full px-3 py-1 text-xs font-medium", statusClass(mandate.status))}
        >
          {mandate.status.replaceAll("_", " ")}
        </span>
      </div>
      <div className="mt-7 grid gap-4 border-t border-border pt-5 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted-foreground">Automatic spending</p>
          <p className="mt-1 font-medium tabular-nums">
            {formatUsdLabel(mandate.rules.autoSpendLimit)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Maximum transaction</p>
          <p className="mt-1 font-medium tabular-nums">
            {formatUsdLabel(mandate.rules.transactionLimit)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Expires</p>
          <p className="mt-1 font-medium">{formatUtcDate(mandate.rules.expiresAt)}</p>
        </div>
      </div>
      <div className="mt-6 flex items-center justify-between gap-3 text-sm font-medium">
        <span className="text-muted-foreground">Version {mandate.version}</span>
        <span className="inline-flex items-center gap-2">
          Open mandate <ArrowRight size={15} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}

export function MandateList() {
  const [mandates, setMandates] = useState<MandateDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMandates(await listMandates());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Mandates could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // This effect synchronizes the client view with the protected server collection.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Link href="/mandates/new" className={cn(buttonVariants({ size: "lg" }))}>
          <Plus size={16} aria-hidden="true" /> Create mandate
        </Link>
      </div>
      {loading ? (
        <div
          className="flex min-h-56 items-center justify-center rounded-2xl border border-border bg-card text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircle size={18} className="mr-2 animate-spin" aria-hidden="true" /> Loading
          mandates…
        </div>
      ) : error ? (
        <div
          className="rounded-2xl border border-destructive/20 bg-destructive/8 p-6 text-sm"
          role="alert"
        >
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-4 font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            Try again
          </button>
        </div>
      ) : mandates.length === 0 ? (
        <section className="rounded-2xl border border-border bg-card p-8 text-center sm:p-14">
          <ShieldCheck size={28} className="mx-auto" aria-hidden="true" />
          <h2 className="mt-5 font-editorial text-3xl tracking-[-0.025em]">No mandates yet.</h2>
          <p className="mx-auto mt-3 max-w-[470px] text-sm leading-relaxed text-muted-foreground">
            Start with a natural-language request and review every permission before it is saved.
          </p>
          <Link href="/mandates/new" className={cn(buttonVariants({ variant: "outline" }), "mt-6")}>
            Create your first mandate <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </section>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {mandates.map((mandate) => (
            <MandateCard key={mandate.id} mandate={mandate} />
          ))}
        </div>
      )}
    </div>
  );
}
