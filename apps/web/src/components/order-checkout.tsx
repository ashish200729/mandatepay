"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { getApproval } from "@/lib/approvals/client";
import { formatUsdLabel, formatUtcDate } from "@/lib/mandates/money";
import {
  createPaypalOrder,
  getPaypalStatus,
  isSafeSandboxApprovalUrl,
} from "@/lib/payments/client";
import type { ApprovalDetail } from "@/lib/approvals/types";
import type { PayPalStatus } from "@/lib/payments/types";

export function OrderCheckout({ proposalId }: { proposalId: string }) {
  const [approval, setApproval] = useState<ApprovalDetail | null>(null);
  const [paypalStatus, setPaypalStatus] = useState<PayPalStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([getApproval(proposalId), getPaypalStatus()])
      .then(([nextApproval, nextPaypal]) => {
        if (active) {
          setApproval(nextApproval);
          setPaypalStatus(nextPaypal);
        }
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Checkout is unavailable.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [proposalId]);

  async function startCheckout() {
    if (!approval || creating || approval.proposal.status !== "AUTHORIZED") return;
    setCreating(true);
    setError(null);
    try {
      const result = await createPaypalOrder(approval.proposal.id);
      if (!result.approvalUrl || !isSafeSandboxApprovalUrl(result.approvalUrl)) {
        throw new Error("PayPal did not return a safe Sandbox approval URL.");
      }
      window.location.assign(result.approvalUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PayPal Sandbox checkout is unavailable.");
      setCreating(false);
    }
  }

  if (loading)
    return (
      <div
        className="flex min-h-56 items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle size={18} className="mr-2 animate-spin" aria-hidden="true" /> Checking
        proposal and Sandbox status…
      </div>
    );
  if (error && !approval)
    return (
      <div
        className="rounded-2xl border border-destructive/20 bg-destructive/8 p-6 text-sm"
        role="alert"
      >
        <p>{error}</p>
        <Link href="/orders" className="mt-4 inline-flex font-medium underline underline-offset-4">
          Back to orders
        </Link>
      </div>
    );
  if (!approval) return null;

  const authorized = approval.proposal.status === "AUTHORIZED";
  return (
    <div className="space-y-7">
      <Link
        href="/orders"
        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Orders
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Sandbox checkout
          </p>
          <h1 className="mt-2 font-editorial text-[clamp(2.6rem,5vw,4.8rem)] leading-[1.02] tracking-[-0.035em]">
            Confirm your purchase.
          </h1>
          <p className="mt-4 max-w-[600px] text-base leading-relaxed text-muted-foreground">
            Review the authorized proposal before opening PayPal Sandbox. This step does not capture
            money.
          </p>
        </div>
        <span className="rounded-full bg-sand px-3 py-1 text-xs font-medium">PayPal Sandbox</span>
      </div>
      <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-sand">
            <ShieldCheck size={20} aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-editorial text-2xl tracking-[-0.02em]">
              {approval.proposal.product.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {approval.proposal.product.brand} · {approval.proposal.product.merchant} ·{" "}
              {approval.proposal.product.condition}
            </p>
          </div>
        </div>
        <div className="mt-7 grid gap-5 border-t border-border pt-6 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="mt-1 text-lg font-medium tabular-nums">
              {formatUsdLabel(approval.proposal.total)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Quantity</p>
            <p className="mt-1 font-medium">{approval.proposal.quantity}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Mandate</p>
            <p className="mt-1 font-medium">
              {approval.proposal.mandate.title} · v{approval.proposal.mandate.version}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Approval expires</p>
            <p className="mt-1 font-medium">
              {approval.proposal.approvalExpiresAt
                ? formatUtcDate(approval.proposal.approvalExpiresAt)
                : "No additional approval required"}
            </p>
          </div>
        </div>
      </section>
      {error ? (
        <div
          className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm"
          role="alert"
        >
          <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : null}
      {!authorized ? (
        <div className="rounded-2xl border border-border bg-secondary p-6 text-sm leading-relaxed">
          <p className="font-medium">This proposal is not authorized for checkout.</p>
          <p className="mt-2 text-muted-foreground">
            Return to approvals and complete the policy decision first.
          </p>
          <Link
            href="/approvals"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4")}
          >
            Open approvals <ArrowLeft size={15} aria-hidden="true" />
          </Link>
        </div>
      ) : !paypalStatus?.configured ? (
        <div className="rounded-2xl border border-border bg-secondary p-6 text-sm leading-relaxed">
          <p className="font-medium">PayPal Sandbox is not configured.</p>
          <p className="mt-2 text-muted-foreground">
            The proposal is authorized, but checkout cannot start until the server has its Sandbox
            credentials.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-sand-border bg-sand p-6">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium">
              <Check size={16} aria-hidden="true" /> Server authorization confirmed
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              PayPal will ask for approval in its Sandbox environment.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void startCheckout()}
            disabled={creating}
            className={cn(buttonVariants({ size: "lg" }))}
          >
            {creating ? (
              <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <ExternalLink size={16} aria-hidden="true" />
            )}{" "}
            {creating ? "Opening PayPal…" : "Open PayPal Sandbox"}
          </button>
        </div>
      )}
    </div>
  );
}
