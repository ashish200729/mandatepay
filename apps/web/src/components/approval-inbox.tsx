"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, CircleAlert, Clock3, LoaderCircle, ShieldCheck, X } from "lucide-react";
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
import { WorkspaceLoading, WorkspaceStatus } from "@/components/workspace-ui";

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

function ProposalCard({
  proposal,
  onOpen,
  active,
  disabled,
}: {
  proposal: ApprovalProposal;
  onOpen: (button: HTMLButtonElement) => void;
  active: boolean;
  disabled: boolean;
}) {
  const resolved = proposal.status !== "AWAITING_APPROVAL";
  return (
    <article
      className={cn(
        "min-w-0 rounded-xl border bg-card p-4",
        active ? "border-foreground" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 break-words">
            <h2 className="text-sm font-medium leading-6">{proposal.product.title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{proposal.product.merchant}</p>
          </div>
        </div>
        <span className="shrink-0 text-sm font-medium tabular-nums">
          {formatUsdLabel(proposal.total)}
        </span>
      </div>
      <div className="mt-3">
        <WorkspaceStatus value={proposal.status} />
      </div>
      <div className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
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
      <div className="mt-3">
        <button
          type="button"
          onClick={(event) => onOpen(event.currentTarget)}
          disabled={disabled}
          aria-pressed={active}
          className={cn(buttonVariants({ variant: "outline" }), "w-full rounded-lg")}
        >
          {resolved ? "View decision" : "Review proposal"}
        </button>
      </div>
    </article>
  );
}

export function ApprovalInbox({ initialProposalId = "" }: { initialProposalId?: string }) {
  const [proposals, setProposals] = useState<ApprovalProposal[]>([]);
  const [selected, setSelected] = useState<ApprovalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const openVersion = useRef(0);
  const initialSelection = useRef(initialProposalId);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const inboxList = useRef<HTMLDivElement>(null);
  const selectedId = selected?.proposal.id;

  useEffect(() => {
    if (!selectedId) return;
    detailHeading.current?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 1279px)").matches)
      detailHeading.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [selectedId]);

  useEffect(() => {
    if (confirm) {
      confirmHeading.current?.focus();
      confirmHeading.current?.scrollIntoView({ block: "nearest" });
    }
  }, [confirm]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProposals(await listApprovals());
      if (initialSelection.current) {
        const id = initialSelection.current;
        initialSelection.current = "";
        setSelected(await getApproval(id));
      }
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
    return () => {
      openVersion.current += 1;
    };
  }, [load]);

  async function openProposal(proposal: ApprovalProposal) {
    if (pending) return;
    const version = ++openVersion.current;
    setError(null);
    setConfirm(null);
    setSelected(null);
    setOpeningId(proposal.id);
    try {
      const detail = await getApproval(proposal.id);
      if (version === openVersion.current) setSelected(detail);
    } catch (cause) {
      if (version === openVersion.current)
        setError(cause instanceof Error ? cause.message : "This proposal could not be loaded.");
    } finally {
      if (version === openVersion.current) setOpeningId(null);
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
              ? "This proposal was already authorized elsewhere. No second decision was recorded."
              : refreshed.proposal.status === "BLOCKED"
                ? "This proposal was already blocked elsewhere. No second decision was recorded."
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

  if (loading) return <WorkspaceLoading label="Loading approvals…" />;
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
    <div className="grid items-start gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
      {error ? (
        <div
          className="flex items-start gap-3 rounded-xl border border-border bg-secondary px-4 py-3 text-sm xl:col-span-2"
          role="alert"
        >
          <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : null}
      {!proposals.length ? (
        <section className="rounded-xl border border-border bg-card p-8 text-center sm:p-12 xl:col-span-2">
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
        <div
          ref={inboxList}
          className={cn(
            "order-2 min-w-0 space-y-3 xl:order-1",
            (selected || openingId) && "hidden xl:block",
          )}
        >
          <h2 className="mb-4 text-sm font-medium">Proposals · {proposals.length}</h2>
          {[...proposals]
            .sort(
              (a, b) =>
                Number(b.status === "AWAITING_APPROVAL") - Number(a.status === "AWAITING_APPROVAL"),
            )
            .map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                onOpen={(button) => {
                  returnFocus.current = button;
                  void openProposal(proposal);
                }}
                active={selected?.proposal.id === proposal.id}
                disabled={Boolean(pending)}
              />
            ))}
        </div>
      )}

      {selected ? (
        <section
          className="order-1 min-w-0 rounded-xl border border-border bg-card p-5 sm:p-6 xl:order-2"
          aria-labelledby="approval-detail-heading"
        >
          <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() => {
              setSelected(null);
              setConfirm(null);
              setError(null);
              requestAnimationFrame(() =>
                (
                  returnFocus.current ??
                  inboxList.current?.querySelector<HTMLButtonElement>("button")
                )?.focus(),
              );
            }}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-4 xl:hidden")}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Back to approval inbox
          </button>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2
                ref={detailHeading}
                tabIndex={-1}
                id="approval-detail-heading"
                className="break-words text-xl font-medium leading-7 tracking-[-0.02em]"
              >
                {selected.proposal.product.title}
              </h2>
            </div>
            <span className="rounded-full bg-background px-3 py-1 text-xs font-medium">
              {selected.proposal.status === "AUTHORIZED"
                ? "Authorized"
                : (selected.decision?.decision ?? selected.proposal.status).replaceAll("_", " ")}
            </span>
          </div>
          <p className="mt-4 rounded-lg bg-sand/60 p-4 text-sm leading-6">
            {selected.proposal.status === "AUTHORIZED"
              ? "This proposal is authorized. Continue to PayPal Sandbox to review and complete checkout."
              : approvalReasonText(selected.decision)}
          </p>
          <div className="mt-5">
            <ProposalSummary proposal={selected.proposal} />
          </div>
          <div className="mt-5 grid gap-4 border-t border-border pt-5 text-sm sm:grid-cols-2">
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
              className={cn(buttonVariants({ size: "lg" }), "mt-6")}
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
              <h3
                ref={confirmHeading}
                tabIndex={-1}
                id="approval-confirm-heading"
                className="font-medium"
              >
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
      ) : openingId ? (
        <div className="order-1 xl:order-2">
          <WorkspaceLoading label="Loading proposal details…" />
        </div>
      ) : proposals.length ? (
        <section className="hidden min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 text-center xl:flex">
          <ShieldCheck size={25} className="text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-4 font-editorial text-2xl">Choose a proposal to review.</h2>
          <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
            See the exact amount, the reason approval is needed, and the permissions behind the
            proposal before you decide.
          </p>
        </section>
      ) : null}
    </div>
  );
}
