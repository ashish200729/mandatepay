"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CircleAlert, LoaderCircle, ShieldCheck } from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { AuditTimeline } from "@/components/audit-timeline";
import { ApprovalApiError, getApproval } from "@/lib/approvals/client";
import { approvalReasonText } from "@/lib/approvals/reasons";
import type { ApprovalDetail } from "@/lib/approvals/types";
import { formatUsdLabel, formatUtcDate } from "@/lib/mandates/money";

function policyExplanation(detail: ApprovalDetail) {
  if (!detail.decision || detail.decision.decision === "REQUIRE_APPROVAL") {
    return approvalReasonText(detail.decision);
  }
  if (detail.decision.decision === "ALLOW") {
    return "AgentGuard allowed this proposal under the recorded mandate rules.";
  }
  if (detail.decision.decision === "BLOCK") {
    return "AgentGuard blocked this proposal. The recorded reasons appear below.";
  }
  return "The latest recorded policy decision and reasons appear below.";
}

export function ProposalDetail({ proposalId }: { proposalId: string }) {
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setDetail(null);
    try {
      const result = await getApproval(proposalId);
      if (version === requestVersion.current) setDetail(result);
    } catch (cause) {
      if (version !== requestVersion.current) return;
      setError(
        cause instanceof ApprovalApiError && cause.status === 404
          ? "This proposal could not be found in your account. Return to the dashboard or try again."
          : cause instanceof Error
            ? cause.message
            : "This proposal could not be loaded. Try again.",
      );
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [proposalId]);

  useEffect(() => {
    // Synchronize the read-only view with the owned proposal endpoint.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      requestVersion.current += 1;
    };
  }, [load]);

  const backLink = (
    <Link
      href="/dashboard"
      className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "w-fit")}
    >
      <ArrowLeft size={15} aria-hidden="true" /> Back to dashboard
    </Link>
  );

  if (loading) {
    return (
      <div className="space-y-5">
        {backLink}
        <div
          className="flex min-h-56 items-center justify-center text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircle
            size={18}
            className="mr-2 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Loading proposal…
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="space-y-5">
        {backLink}
        <section
          className="rounded-2xl border border-destructive/20 bg-destructive/8 p-6 sm:p-8"
          role="alert"
        >
          <h1 className="flex items-center gap-2 font-editorial text-2xl tracking-[-0.02em]">
            <CircleAlert size={20} aria-hidden="true" /> Proposal unavailable
          </h1>
          <p className="mt-3 text-sm leading-relaxed">
            {error ?? "The proposal response was empty. Try again."}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className={cn(buttonVariants({ variant: "outline" }), "mt-5")}
          >
            Try again
          </button>
        </section>
      </div>
    );
  }

  const { proposal, decision } = detail;

  return (
    <div className="space-y-6">
      {backLink}
      <section
        className="rounded-2xl border border-border bg-card p-6 sm:p-8"
        aria-labelledby="proposal-heading"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 basis-64">
            <h1
              id="proposal-heading"
              className="break-words font-editorial text-3xl tracking-[-0.025em] sm:text-4xl"
            >
              {proposal.product.title}
            </h1>
            <p className="mt-3 break-words text-sm leading-relaxed text-muted-foreground">
              {proposal.product.brand} · {proposal.product.merchant}
            </p>
          </div>
          <span className="rounded-full bg-sand px-3 py-1.5 text-xs font-medium">
            {proposal.status.replaceAll("_", " ")}
          </span>
        </div>
        <dl className="mt-7 grid gap-x-6 gap-y-5 border-t border-border pt-6 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Total · {proposal.currency}</dt>
            <dd className="mt-1 font-medium tabular-nums">{formatUsdLabel(proposal.total)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Quantity</dt>
            <dd className="mt-1 font-medium tabular-nums">{proposal.quantity}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Tax</dt>
            <dd className="mt-1 font-medium tabular-nums">{formatUsdLabel(proposal.tax)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Shipping</dt>
            <dd className="mt-1 font-medium tabular-nums">{formatUsdLabel(proposal.shipping)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Condition</dt>
            <dd className="mt-1 font-medium">{proposal.product.condition.replaceAll("_", " ")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Product source</dt>
            <dd className="mt-1 font-medium">
              {proposal.product.source === "demo" ? "Demo catalog" : "Channel3"}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Mandate version</dt>
            <dd className="mt-1 break-words font-medium">
              {proposal.mandate.title} · v{proposal.mandate.version}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Proposal expires</dt>
            <dd className="mt-1 font-medium">
              {proposal.expiresAt ? (
                <time dateTime={proposal.expiresAt}>{formatUtcDate(proposal.expiresAt)}</time>
              ) : (
                "No expiry recorded"
              )}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Approval expires</dt>
            <dd className="mt-1 font-medium">
              {proposal.approvalExpiresAt ? (
                <time dateTime={proposal.approvalExpiresAt}>
                  {formatUtcDate(proposal.approvalExpiresAt)}
                </time>
              ) : (
                "No approval deadline recorded"
              )}
            </dd>
          </div>
        </dl>
        <p className="mt-6 break-all border-t border-border pt-5 text-xs text-muted-foreground">
          Proposal ID: {proposal.id}
        </p>
      </section>

      <section
        className="rounded-2xl border border-sand-border bg-sand p-6 sm:p-8"
        aria-labelledby="proposal-policy-heading"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2
            id="proposal-policy-heading"
            className="flex items-center gap-2 font-editorial text-2xl tracking-[-0.02em]"
          >
            <ShieldCheck size={20} aria-hidden="true" /> Policy decision
          </h2>
          <span className="rounded-full bg-background px-3 py-1.5 text-xs font-medium">
            {decision ? decision.decision.replaceAll("_", " ") : "Not evaluated"}
          </span>
        </div>
        <p className="mt-4 max-w-[70ch] text-sm leading-relaxed text-muted-foreground">
          {policyExplanation(detail)}
        </p>
        {decision?.reasonCodes.length ? (
          <div className="mt-5">
            <h3 className="text-sm font-medium">Recorded reason codes</h3>
            <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
              {decision.reasonCodes.map((code, index) => (
                <li key={`${code}-${index}`} className="break-words">
                  {code.replaceAll("_", " ")}
                </li>
              ))}
            </ul>
          </div>
        ) : decision ? (
          <p className="mt-4 text-sm text-muted-foreground">No reason codes were recorded.</p>
        ) : null}
        {proposal.status === "AWAITING_APPROVAL" ? (
          <div className="mt-6 border-t border-sand-border pt-5">
            <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
              Review this exact proposal in the approval inbox before recording a decision.
            </p>
            <Link href="/approvals" className={cn(buttonVariants())}>
              Open approval inbox <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        ) : proposal.status === "AUTHORIZED" ? (
          <div className="mt-6 border-t border-sand-border pt-5">
            <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
              Continue to checkout to review the proposal before starting a Sandbox payment.
            </p>
            <Link
              href={`/orders/new?proposalId=${encodeURIComponent(proposal.id)}`}
              className={cn(buttonVariants())}
            >
              Continue to Sandbox checkout <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        ) : (
          <p className="mt-6 border-t border-sand-border pt-5 text-sm text-muted-foreground">
            No approval or checkout action is available for this proposal’s current status.
          </p>
        )}
      </section>
      <AuditTimeline entityId={proposal.id} />
    </div>
  );
}
