"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, CircleAlert, Clock3, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { formatUsdLabel, formatUtcDate } from "@/lib/mandates/money";
import {
  ApprovalApiError,
  decideApproval,
  getApproval,
  listApprovals,
} from "@/lib/approvals/client";
import { approvalReasonText } from "@/lib/approvals/reasons";
import type { ApprovalDetail, ApprovalProposal } from "@/lib/approvals/types";

function ProposalSummary({ proposal }: { proposal: ApprovalProposal }) {
  return (
    <div className="grid gap-4 border-t border-border pt-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <p className="text-xs text-muted-foreground">Total</p>
        <p className="mt-1 font-medium tabular-nums">{formatUsdLabel(proposal.total)}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Quantity</p>
        <p className="mt-1 font-medium">{proposal.quantity}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Shipping</p>
        <p className="mt-1 font-medium tabular-nums">{formatUsdLabel(proposal.shipping)}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Tax</p>
        <p className="mt-1 font-medium tabular-nums">{formatUsdLabel(proposal.tax)}</p>
      </div>
    </div>
  );
}

function ProposalCard({ proposal, onOpen }: { proposal: ApprovalProposal; onOpen: () => void }) {
  const resolved = proposal.status !== "AWAITING_APPROVAL";
  return (
    <article className="rounded-2xl border border-border bg-card p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sand">
            <ShieldCheck size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-editorial text-2xl tracking-[-0.02em]">{proposal.product.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {proposal.product.brand} · {proposal.product.merchant} · {proposal.product.condition}
            </p>
          </div>
        </div>
        <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium">
          {proposal.status.replaceAll("_", " ")}
        </span>
      </div>
      <ProposalSummary proposal={proposal} />
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5 text-xs text-muted-foreground">
        <span>
          Mandate: {proposal.mandate.title} · v{proposal.mandate.version}
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock3 size={13} aria-hidden="true" /> Approval expires{" "}
          {proposal.approvalExpiresAt
            ? formatUtcDate(proposal.approvalExpiresAt)
            : "No additional approval required"}
        </span>
      </div>
      <div className="mt-5 flex justify-end">
        {proposal.status === "AUTHORIZED" ? (
          <Link
            href={`/orders/new?proposalId=${encodeURIComponent(proposal.id)}`}
            className={cn(buttonVariants({ size: "sm" }), "mr-2")}
          >
            Continue to Sandbox checkout
          </Link>
        ) : null}
        <button
          type="button"
          onClick={onOpen}
          className={cn(buttonVariants({ variant: resolved ? "outline" : "default" }))}
        >
          {resolved ? "View decision" : "Review proposal"}
        </button>
      </div>
    </article>
  );
}

export function ApprovalInbox() {
  const [proposals, setProposals] = useState<ApprovalProposal[]>([]);
  const [selected, setSelected] = useState<ApprovalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProposals(await listApprovals());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Approvals could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial synchronization with the protected approvals collection.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function openProposal(proposal: ApprovalProposal) {
    setError(null);
    setConfirm(null);
    try {
      setSelected(await getApproval(proposal.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This proposal could not be loaded.");
    }
  }

  async function decide(decision: "approve" | "reject") {
    if (!selected || pending) return;
    if (confirm !== decision) {
      setConfirm(decision);
      return;
    }
    setPending(decision);
    setError(null);
    try {
      const next = await decideApproval(selected.proposal.id, decision);
      setSelected(next);
      setProposals((current) =>
        current.map((proposal) => (proposal.id === next.proposal.id ? next.proposal : proposal)),
      );
      setConfirm(null);
    } catch (cause) {
      if (cause instanceof ApprovalApiError && cause.status === 409) {
        try {
          const refreshed = await getApproval(selected.proposal.id);
          setSelected(refreshed);
          await load();
          setError(
            refreshed.proposal.status === "AUTHORIZED"
              ? "This proposal was already approved elsewhere. No second decision was recorded."
              : refreshed.proposal.status === "BLOCKED"
                ? "This proposal was already rejected elsewhere. No second decision was recorded."
                : "This proposal changed elsewhere. The inbox has been refreshed.",
          );
        } catch {
          await load();
          setError("This proposal changed elsewhere. The inbox has been refreshed.");
        }
      } else {
        setError(cause instanceof Error ? cause.message : "The approval decision failed.");
      }
    } finally {
      setPending(null);
    }
  }

  if (loading)
    return (
      <div
        className="flex min-h-56 items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle size={18} className="mr-2 animate-spin" aria-hidden="true" /> Loading
        approvals…
      </div>
    );
  if (error && !proposals.length)
    return (
      <div
        className="rounded-2xl border border-destructive/20 bg-destructive/8 p-6 text-sm"
        role="alert"
      >
        <p>{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-4 font-medium underline underline-offset-4"
        >
          Try again
        </button>
      </div>
    );

  return (
    <div className="space-y-5">
      {error ? (
        <div
          className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm"
          role="alert"
        >
          <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : null}
      {!proposals.length ? (
        <section className="rounded-2xl border border-border bg-card p-8 text-center sm:p-14">
          <Check size={28} className="mx-auto" aria-hidden="true" />
          <h2 className="mt-5 font-editorial text-3xl tracking-[-0.025em]">
            Nothing needs your attention.
          </h2>
          <p className="mx-auto mt-3 max-w-[470px] text-sm leading-relaxed text-muted-foreground">
            Proposals that require your decision will appear here with their exact product, mandate,
            policy reason, and expiry.
          </p>
        </section>
      ) : (
        <div className="space-y-5">
          {proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              onOpen={() => void openProposal(proposal)}
            />
          ))}
        </div>
      )}

      {selected ? (
        <section
          className="rounded-2xl border border-sand-border bg-sand p-5 sm:p-7"
          aria-labelledby="approval-detail-heading"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Policy decision
              </p>
              <h2
                id="approval-detail-heading"
                className="mt-2 font-editorial text-3xl tracking-[-0.025em]"
              >
                {selected.proposal.product.title}
              </h2>
            </div>
            <span className="rounded-full bg-background px-3 py-1 text-xs font-medium">
              {selected.proposal.status === "AUTHORIZED"
                ? "Human approved"
                : (selected.decision?.decision ?? selected.proposal.status)}
            </span>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            {selected.proposal.status === "AUTHORIZED"
              ? "You approved this exact proposal. No payment has been made; continue to PayPal Sandbox to complete checkout."
              : approvalReasonText(selected.decision)}
          </p>
          <div className="mt-5">
            <ProposalSummary proposal={selected.proposal} />
          </div>
          <div className="mt-5 grid gap-4 border-t border-sand-border pt-5 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">Merchant</p>
              <p className="mt-1 font-medium">{selected.proposal.product.merchant}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Condition</p>
              <p className="mt-1 font-medium">{selected.proposal.product.condition}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Mandate version</p>
              <p className="mt-1 font-medium">
                {selected.proposal.mandate.title} · v{selected.proposal.mandate.version}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Proposal expires</p>
              <p className="mt-1 font-medium">{formatUtcDate(selected.proposal.expiresAt)}</p>
            </div>
          </div>
          {selected.proposal.status === "AWAITING_APPROVAL" ? (
            <div className="mt-6 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void decide("approve")}
                disabled={Boolean(pending)}
                className={cn(buttonVariants())}
              >
                {pending === "approve" ? (
                  <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Check size={15} aria-hidden="true" />
                )}{" "}
                Approve proposal
              </button>
              <button
                type="button"
                onClick={() => void decide("reject")}
                disabled={Boolean(pending)}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                <X size={15} aria-hidden="true" /> Reject proposal
              </button>
            </div>
          ) : selected.proposal.status === "AUTHORIZED" ? (
            <Link
              href={`/orders/new?proposalId=${encodeURIComponent(selected.proposal.id)}`}
              className={cn(buttonVariants({ size: "lg" }))}
            >
              Continue to Sandbox checkout
            </Link>
          ) : (
            <p className="mt-6 text-sm font-medium">
              This proposal is already {selected.proposal.status.toLowerCase()}. No second decision
              is available.
            </p>
          )}
          {confirm ? (
            <div
              className="mt-5 rounded-xl border border-foreground/15 bg-background p-4"
              role="alertdialog"
              aria-labelledby="approval-confirm-heading"
            >
              <h3 id="approval-confirm-heading" className="font-medium">
                {confirm === "approve" ? "Approve this proposal?" : "Reject this proposal?"}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                This records your decision for the current proposal version. It does not execute
                PayPal or any other payment.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void decide(confirm)}
                  disabled={Boolean(pending)}
                  className={cn(buttonVariants({ size: "sm" }))}
                >
                  {confirm === "approve" ? "Yes, approve" : "Yes, reject"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirm(null)}
                  disabled={Boolean(pending)}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                >
                  Keep reviewing
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
