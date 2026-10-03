"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  LoaderCircle,
  RotateCcw,
  Send,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { approvalReasonText } from "@/lib/approvals/reasons";
import { listMandates } from "@/lib/mandates/client";
import { formatUsdLabel, formatUtcDate } from "@/lib/mandates/money";
import { createShoppingRequestKey, sendShoppingMessage } from "@/lib/agent/client";
import { activeShoppingMandates, selectShoppingMandate } from "@/lib/agent/mandates";
import { saveRefundDraft } from "@/lib/agent/refund-draft";
import type { RefundDraft, ShoppingAgentResponse } from "@/lib/agent/types";
import type { MandateDetail } from "@/lib/mandates/types";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  response?: ShoppingAgentResponse;
};

function ProposalCard({ response }: { response: ShoppingAgentResponse }) {
  return (
    <div className="mt-5 space-y-4">
      {response.proposals.map((proposal) => (
        <article key={proposal.id} className="rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Server proposal
              </p>
              <h3 className="mt-2 font-editorial text-2xl tracking-[-0.02em]">
                {proposal.product.title}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {proposal.product.brand ? `${proposal.product.brand} · ` : ""}
                {proposal.product.merchant} · {proposal.product.condition}
              </p>
            </div>
            <span className="rounded-full bg-sand px-3 py-1 text-xs font-medium">
              {proposal.status.replaceAll("_", " ")}
            </span>
          </div>
          <div className="mt-5 grid gap-4 border-t border-border pt-5 text-sm sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="mt-1 font-medium tabular-nums">{formatUsdLabel(proposal.total)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Mandate</p>
              <p className="mt-1 font-medium">
                {proposal.mandate.title} · v{proposal.mandate.version}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Expires</p>
              <p className="mt-1 font-medium">
                {formatUtcDate(proposal.approvalExpiresAt ?? proposal.expiresAt ?? undefined)}
              </p>
            </div>
          </div>
          {proposal.decision ? (
            <div className="mt-5 rounded-xl bg-secondary p-4 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <Check size={15} aria-hidden="true" /> AgentGuard: {proposal.decision.decision}
              </p>
              <p className="mt-2 leading-relaxed text-muted-foreground">
                {approvalReasonText(proposal.decision)}
              </p>
            </div>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            {proposal.status === "AWAITING_APPROVAL" ? (
              <Link href={`/approvals`} className={cn(buttonVariants({ size: "sm" }))}>
                Review approval <ArrowRight size={14} aria-hidden="true" />
              </Link>
            ) : null}
            {proposal.status === "AUTHORIZED" ? (
              <Link
                href={`/orders/new?proposalId=${encodeURIComponent(proposal.id)}`}
                className={cn(buttonVariants({ size: "sm" }))}
              >
                Continue to Sandbox checkout <ArrowRight size={14} aria-hidden="true" />
              </Link>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function RefundDraftCard({ draft }: { draft: RefundDraft }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-5 rounded-xl border border-sand-border bg-sand p-4 text-sm">
      <p className="font-medium">Refund request prepared.</p>
      <p className="mt-2 text-muted-foreground">
        {draft.amountMinor === null ? "Full remaining refund" : formatUsdLabel(draft.amountMinor)} ·{" "}
        {draft.reason}
      </p>
      <Link
        href={draft.reviewUrl}
        onClick={(event) => {
          try {
            saveRefundDraft(draft);
            setError(null);
          } catch {
            event.preventDefault();
            setError(
              "Your browser could not save this draft. Open the order from Orders and enter these details to review the refund.",
            );
          }
        }}
        className="mt-3 inline-flex min-h-10 items-center gap-2 font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        Review refund <ArrowRight size={14} aria-hidden="true" />
      </Link>
      {error ? (
        <p className="mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AgentMessage({ message }: { message: ChatMessage }) {
  if (message.role === "user")
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm leading-relaxed text-primary-foreground">
          <div className="mb-2 flex items-center gap-2 text-xs text-primary-foreground/70">
            <UserRound size={13} aria-hidden="true" /> You
          </div>
          {message.text}
        </div>
      </div>
    );
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-4 text-sm leading-relaxed">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Bot size={14} aria-hidden="true" /> MandatePay
        </div>
        <p className="mt-3 whitespace-pre-wrap">{message.text}</p>
        {message.response ? (
          <>
            {message.response.explanation ? (
              <div className="mt-4 rounded-xl border border-border bg-secondary/60 px-4 py-3 text-sm">
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Agent explanation
                </p>
                <p className="mt-2 leading-relaxed">{message.response.explanation.text}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Policy and payment state remain authoritative on the server.
                </p>
              </div>
            ) : null}
            <ProposalCard response={message.response} />
            {message.response.refundDraft ? (
              <RefundDraftCard draft={message.response.refundDraft} />
            ) : null}
            <details className="mt-5 border-t border-border pt-4">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground underline-offset-4 hover:underline">
                Show server steps
              </summary>
              <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
                {message.response.steps.map((step, index) => (
                  <li
                    key={`${message.id}-${index}-${step.name}`}
                    className="flex items-center gap-2"
                  >
                    <Check size={13} aria-hidden="true" />
                    {step.name}
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function ShoppingChat() {
  const [mandates, setMandates] = useState<MandateDetail[]>([]);
  const [mandateId, setMandateId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState("");
  const [loadingMandates, setLoadingMandates] = useState(true);
  const [sending, setSending] = useState(false);
  const [retry, setRetry] = useState<{
    message: string;
    mandateId?: string;
    requestKey: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMandates = useCallback(async () => {
    setLoadingMandates(true);
    setError(null);
    try {
      const next = await listMandates();
      const active = activeShoppingMandates(next);
      setMandates(active);
      setMandateId((current) => selectShoppingMandate(active, current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Active mandates could not be loaded.");
    } finally {
      setLoadingMandates(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMandates();
  }, [loadMandates]);

  async function send(nextMessage = message, existing?: typeof retry) {
    const text = nextMessage.trim();
    const selectedMandate = existing ? existing.mandateId : mandateId || undefined;
    if (!text || sending) return;
    const request = existing ?? {
      message: text,
      ...(selectedMandate ? { mandateId: selectedMandate } : {}),
      requestKey: createShoppingRequestKey(),
    };
    setSending(true);
    setError(null);
    if (!existing) {
      setMessage("");
      setMessages((current) => [
        ...current,
        { id: `${request.requestKey}-user`, role: "user", text },
      ]);
    }
    try {
      const response = await sendShoppingMessage(
        request.message,
        request.mandateId,
        request.requestKey,
      );
      setMessages((current) => [
        ...current,
        {
          id: `${request.requestKey}-assistant`,
          role: "assistant",
          text: response.message,
          response,
        },
      ]);
      setRetry(null);
    } catch (cause) {
      setRetry(request);
      setError(
        cause instanceof Error
          ? cause.message
          : "The shopping agent could not complete the request.",
      );
    } finally {
      setSending(false);
    }
  }

  if (loadingMandates)
    return (
      <div
        className="flex min-h-56 items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle size={18} className="mr-2 animate-spin" aria-hidden="true" /> Loading active
        mandates…
      </div>
    );
  return (
    <div className="space-y-6">
      {!mandates.length ? (
        <section className="rounded-2xl border border-border bg-card p-5 sm:p-7">
          <h2 className="flex items-center gap-2 font-medium">
            <ShieldCheck size={18} aria-hidden="true" /> You can still ask about refunds.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Refunds use your existing captured payments. Create and activate a mandate before asking
            the agent to shop or prepare a purchase.
          </p>
          <Link href="/mandates/new" className={cn(buttonVariants({ size: "sm" }), "mt-4")}>
            Create a mandate <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </section>
      ) : (
        <section className="rounded-2xl border border-border bg-card p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Shopping mandate
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {mandateId
                  ? "The server uses this permission set for shopping tools and proposals."
                  : "Choose a mandate before shopping. You can ask about refunds without one."}
              </p>
            </div>
            <label className="flex w-full flex-col gap-2 text-sm font-medium sm:w-auto sm:flex-row sm:items-center">
              Mandate
              <select
                value={mandateId}
                onChange={(event) => setMandateId(event.currentTarget.value)}
                disabled={sending}
                className="h-10 w-full min-w-0 rounded-xl border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:w-auto sm:max-w-80"
              >
                <option value="">Choose a mandate · optional for refunds</option>
                {mandates.map((mandate) => (
                  <option key={mandate.id} value={mandate.id}>
                    {mandate.title} · v{mandate.version}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      )}
      <div className="min-h-[300px] space-y-5 rounded-2xl border border-border bg-secondary/50 p-4 sm:p-7">
        {messages.length ? (
          messages.map((item) => <AgentMessage key={item.id} message={item} />)
        ) : (
          <div className="flex min-h-64 items-center justify-center text-center">
            <div>
              <Bot size={26} className="mx-auto" aria-hidden="true" />
              <h2 className="mt-4 font-editorial text-3xl tracking-[-0.025em]">
                What are you looking for?
              </h2>
              <p className="mt-3 max-w-[440px] text-sm leading-relaxed text-muted-foreground">
                Ask for a product, compare a few options, or prepare a refund request. The server
                owns prices, policy decisions, and payment state.
              </p>
            </div>
          </div>
        )}
        {sending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> Agent tools are
            working…
          </div>
        ) : null}
      </div>
      {error ? (
        <div
          className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm"
          role="alert"
        >
          <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : null}
      {retry ? (
        <button
          type="button"
          onClick={() => void send(retry.message, retry)}
          disabled={sending}
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          <RotateCcw size={15} aria-hidden="true" /> Retry same request
        </button>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="rounded-2xl border border-border bg-card p-4 sm:p-5"
      >
        <label htmlFor="shopping-message" className="sr-only">
          Message the shopping agent
        </label>
        <textarea
          id="shopping-message"
          value={message}
          onChange={(event) => setMessage(event.currentTarget.value)}
          disabled={sending}
          maxLength={1000}
          placeholder={
            mandateId
              ? "Find a good pair of Sony headphones under $180…"
              : "Help me refund a previous purchase…"
          }
          className="min-h-24 w-full resize-y rounded-lg border-0 bg-transparent text-sm leading-relaxed placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:opacity-60"
        />
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">
            AI proposes. AgentGuard authorizes. PayPal remains separate.
          </span>
          <button
            type="submit"
            disabled={sending || !message.trim()}
            className={cn(buttonVariants({ size: "sm" }))}
          >
            <Send size={15} aria-hidden="true" /> Send
          </button>
        </div>
      </form>
    </div>
  );
}
