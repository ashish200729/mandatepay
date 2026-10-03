"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Edit3,
  LoaderCircle,
  Pause,
  Play,
  ShieldCheck,
  X,
} from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import {
  getMandate,
  MandateApiError,
  transitionMandate,
  updateMandate,
} from "@/lib/mandates/client";
import { formatUsdLabel, formatUtcDate } from "@/lib/mandates/money";
import { canonicalToForm, formToCanonical, MandateForm } from "@/components/mandate-form";
import type {
  MandateAction,
  MandateDetail as MandateDetailType,
  MandateFormState,
} from "@/lib/mandates/types";

function statusClass(status: string) {
  if (status === "ACTIVE") return "bg-primary text-primary-foreground";
  if (status === "PAUSED") return "bg-sand text-foreground";
  return "bg-secondary text-muted-foreground";
}

function actionLabel(
  status: string,
): { action: MandateAction; label: string; icon: typeof Play } | null {
  if (status === "ACTIVE") return { action: "pause", label: "Pause mandate", icon: Pause };
  if (status === "PAUSED") return { action: "resume", label: "Resume mandate", icon: Play };
  if (status === "DRAFT")
    return { action: "activate", label: "Activate mandate", icon: ShieldCheck };
  return null;
}

export function MandateDetail({ mandateId }: { mandateId: string }) {
  const [mandate, setMandate] = useState<MandateDetailType | null>(null);
  const [form, setForm] = useState<MandateFormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [pending, setPending] = useState<"save" | MandateAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getMandate(mandateId);
      setMandate(next);
      setForm(canonicalToForm(next.rules));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This mandate could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [mandateId]);

  useEffect(() => {
    // This effect synchronizes the client view with the protected server record.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function runAction(action: MandateAction) {
    if (!mandate || pending) return;
    if (action === "revoke" && !confirmRevoke) {
      setConfirmRevoke(true);
      return;
    }

    setPending(action);
    setError(null);
    try {
      const updated = await transitionMandate(mandate.id, action, mandate.version);
      setMandate(updated);
      setForm(canonicalToForm(updated.rules));
      setConfirmRevoke(false);
    } catch (cause) {
      if (cause instanceof MandateApiError && cause.status === 409) {
        await load();
        setError(
          "This mandate changed elsewhere. It has been refreshed; review it before trying again.",
        );
      } else {
        setError(cause instanceof Error ? cause.message : "The mandate action failed.");
      }
    } finally {
      setPending(null);
    }
  }

  async function saveEdit() {
    if (!mandate || !form || pending) return;
    let canonical;
    try {
      canonical = formToCanonical(form);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review the mandate fields and try again.");
      return;
    }

    setPending("save");
    setError(null);
    try {
      const updated = await updateMandate(
        mandate.id,
        mandate.version,
        mandate.originalPrompt,
        canonical,
      );
      setMandate(updated);
      setForm(canonicalToForm(updated.rules));
      setEditing(false);
    } catch (cause) {
      if (cause instanceof MandateApiError && cause.status === 409) {
        await load();
        setError("This mandate changed elsewhere. It has been refreshed; review it before saving.");
      } else {
        setError(cause instanceof Error ? cause.message : "The mandate could not be updated.");
      }
    } finally {
      setPending(null);
    }
  }

  if (loading) {
    return (
      <div
        className="flex min-h-56 items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle size={18} className="mr-2 animate-spin" aria-hidden="true" /> Loading mandate…
      </div>
    );
  }
  if (!mandate || !form) {
    return (
      <div
        className="rounded-2xl border border-destructive/20 bg-destructive/8 p-6 text-sm"
        role="alert"
      >
        <p>{error ?? "Mandate not found."}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-4 font-medium underline underline-offset-4"
        >
          Try again
        </button>
      </div>
    );
  }

  const nextAction = actionLabel(mandate.status);
  const canEdit = mandate.status !== "REVOKED";
  const ActionIcon = nextAction?.icon;

  return (
    <div className="space-y-7">
      <Link
        href="/mandates"
        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        <ArrowLeft size={15} aria-hidden="true" /> All mandates
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex items-start gap-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-sand">
            <ShieldCheck size={22} aria-hidden="true" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-editorial text-[clamp(2.4rem,5vw,4.5rem)] leading-[1.02] tracking-[-0.035em]">
                {mandate.title}
              </h1>
              <span
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium",
                  statusClass(mandate.status),
                )}
              >
                {mandate.status}
              </span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Version {mandate.version} · {mandate.rules.timezone}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit ? (
            <button
              type="button"
              onClick={() => {
                setEditing((current) => !current);
                setError(null);
              }}
              disabled={Boolean(pending)}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              <Edit3 size={15} aria-hidden="true" /> {editing ? "Close editor" : "Edit permissions"}
            </button>
          ) : null}
          {nextAction && ActionIcon ? (
            <button
              type="button"
              onClick={() => void runAction(nextAction.action)}
              disabled={Boolean(pending)}
              className={cn(buttonVariants())}
            >
              {pending === nextAction.action ? (
                <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
              ) : (
                <ActionIcon size={15} aria-hidden="true" />
              )}{" "}
              {pending === nextAction.action ? "Saving…" : nextAction.label}
            </button>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              onClick={() => void runAction("revoke")}
              disabled={Boolean(pending)}
              className={cn(buttonVariants({ variant: "ghost" }))}
            >
              <X size={15} aria-hidden="true" /> Revoke
            </button>
          ) : null}
        </div>
      </div>

      {confirmRevoke ? (
        <section
          className="rounded-2xl border border-destructive/25 bg-destructive/8 p-5"
          role="alertdialog"
          aria-labelledby="revoke-heading"
          aria-describedby="revoke-description"
        >
          <h2 id="revoke-heading" className="font-medium">
            Revoke this mandate?
          </h2>
          <p id="revoke-description" className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Future proposals will not be authorized by this mandate. Existing payment records remain
            unchanged.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void runAction("revoke")}
              disabled={Boolean(pending)}
              className={cn(buttonVariants({ variant: "destructive", size: "sm" }))}
            >
              Yes, revoke mandate
            </button>
            <button
              type="button"
              onClick={() => setConfirmRevoke(false)}
              disabled={Boolean(pending)}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              Keep mandate
            </button>
          </div>
        </section>
      ) : null}
      {error ? (
        <div
          className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm"
          role="alert"
        >
          <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : null}

      <section className="rounded-2xl border border-sand-border bg-sand p-5 sm:p-7">
        <p className="text-xs font-medium text-muted-foreground">Original instruction</p>
        <blockquote className="mt-4 font-editorial text-2xl leading-tight tracking-[-0.02em]">
          “{mandate.originalPrompt}”
        </blockquote>
      </section>

      {editing ? (
        <div className="space-y-5">
          <MandateForm value={form} onChange={setForm} disabled={pending === "save"} />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void saveEdit()}
              disabled={Boolean(pending)}
              className={cn(buttonVariants({ size: "lg" }))}
            >
              {pending === "save" ? (
                <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
              ) : (
                <Check size={16} aria-hidden="true" />
              )}{" "}
              {pending === "save" ? "Saving version…" : "Save new version"}
            </button>
          </div>
        </div>
      ) : (
        <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
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
              <p className="text-xs text-muted-foreground">Quantity</p>
              <p className="mt-1 font-medium">{mandate.rules.quantityLimit}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Expires</p>
              <p className="mt-1 font-medium">{formatUtcDate(mandate.rules.expiresAt)}</p>
            </div>
          </div>
          <dl className="mt-8 grid gap-5 border-t border-border pt-6 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Allowed brands</dt>
              <dd className="mt-1 font-medium">
                {mandate.rules.allowedBrands.join(", ") || "Any brand"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Conditions</dt>
              <dd className="mt-1 font-medium">{mandate.rules.allowedConditions.join(", ")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Allowed merchants</dt>
              <dd className="mt-1 font-medium">
                {mandate.rules.allowedMerchants.join(", ") || "Any merchant"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">New merchant</dt>
              <dd className="mt-1 font-medium">
                {mandate.rules.newMerchantRequiresApproval
                  ? "Approval required"
                  : "Allowed automatically"}
              </dd>
            </div>
          </dl>
          <details className="mt-8 border-t border-border pt-5">
            <summary className="cursor-pointer text-sm font-medium underline-offset-4 hover:underline">
              View recorded rules JSON
            </summary>
            <pre className="mt-4 overflow-x-auto rounded-xl bg-secondary p-4 text-xs leading-relaxed">
              {JSON.stringify(mandate.rules, null, 2)}
            </pre>
          </details>
        </section>
      )}
    </div>
  );
}
