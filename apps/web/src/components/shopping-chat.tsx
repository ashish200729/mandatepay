"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowDown,
  Bot,
  Check,
  CircleAlert,
  LoaderCircle,
  RotateCcw,
  Send,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { approvalReasonText } from "@/lib/approvals/reasons";
import { listMandates } from "@/lib/mandates/client";
import { formatUsdLabel, formatUtcDate } from "@/lib/mandates/money";
import {
  createShoppingRequestKey,
  sendShoppingMessage,
  ShoppingAgentApiError,
} from "@/lib/agent/client";
import { activeShoppingMandates, selectShoppingMandate } from "@/lib/agent/mandates";
import { saveRefundDraft } from "@/lib/agent/refund-draft";
import type { RefundDraft, ShoppingAgentResponse } from "@/lib/agent/types";
import type { MandateDetail } from "@/lib/mandates/types";
import { workspaceField, WorkspaceLoading, WorkspaceStatus } from "@/components/workspace-ui";
import { ChatAnswer } from "@/components/chat-answer";

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
        <article
          key={proposal.id}
          className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1 basis-48">
              <h3 className="break-words text-base font-medium leading-6">
                {proposal.product.title}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {proposal.product.brand ? `${proposal.product.brand} · ` : ""}
                {proposal.product.merchant} · {proposal.product.condition}
              </p>
            </div>
            <WorkspaceStatus value={proposal.status} />
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
            <div className="mt-4 border-t border-border pt-4 text-sm">
              <p className="flex items-center gap-2 font-medium">
                {proposal.decision.decision === "BLOCK" ? (
                  <X size={15} aria-hidden="true" />
                ) : (
                  <ShieldCheck size={15} aria-hidden="true" />
                )}{" "}
                AgentGuard: {proposal.decision.decision.replaceAll("_", " ")}
              </p>
              <p className="mt-2 leading-relaxed text-muted-foreground">
                {approvalReasonText(proposal.decision)}
              </p>
            </div>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            {proposal.status === "AWAITING_APPROVAL" ? (
              <Link
                href={`/approvals?proposal=${encodeURIComponent(proposal.id)}`}
                className={cn(buttonVariants({ size: "sm" }))}
              >
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
        <div className="max-w-[90%] break-words rounded-2xl rounded-br-md bg-secondary px-4 py-3 text-sm leading-6 text-foreground sm:max-w-[80%]">
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <UserRound size={13} aria-hidden="true" /> You
          </div>
          {message.text}
        </div>
      </div>
    );
  return (
    <div className="flex justify-start">
      <div className="min-w-0 w-full text-sm leading-6">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Bot size={14} aria-hidden="true" /> MandatePay
        </div>
        <ChatAnswer text={message.response?.explanation?.text ?? message.text} />
        {message.response ? (
          <>
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

export function ShoppingChat({ initialMandateId = "" }: { initialMandateId?: string }) {
  const [mandates, setMandates] = useState<MandateDetail[]>([]);
  const [mandateId, setMandateId] = useState(initialMandateId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState("");
  const [loadingMandates, setLoadingMandates] = useState(true);
  const [sending, setSending] = useState(false);
  const [retry, setRetry] = useState<{
    message: string;
    mandateId?: string;
    requestKey: string;
    productContext?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mandatesFailed, setMandatesFailed] = useState(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const thread = useRef<HTMLDivElement>(null);
  const threadContent = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const followLatest = useRef(true);
  const threadLayout = useRef<{ width: number; height: number; contentHeight: number } | null>(
    null,
  );
  const productContext = useRef<{ mandateId: string | undefined; value: string } | null>(null);

  useEffect(() => {
    if (followLatest.current && thread.current)
      thread.current.scrollTop = thread.current.scrollHeight;
  }, [messages.length, sending]);

  useEffect(() => {
    if (!thread.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!thread.current) return;
      if (followLatest.current) thread.current.scrollTop = thread.current.scrollHeight;
      threadLayout.current = {
        width: thread.current.clientWidth,
        height: thread.current.clientHeight,
        contentHeight: thread.current.scrollHeight,
      };
    });
    observer.observe(thread.current);
    if (threadContent.current) observer.observe(threadContent.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!composer.current) return;
    composer.current.style.height = "auto";
    composer.current.style.height = `${Math.min(160, composer.current.scrollHeight)}px`;
  }, [message]);

  const loadMandates = useCallback(async () => {
    setLoadingMandates(true);
    setError(null);
    setMandatesFailed(false);
    try {
      const next = await listMandates();
      const active = activeShoppingMandates(next);
      setMandates(active);
      setMandateId((current) => selectShoppingMandate(active, current));
    } catch (cause) {
      setMandatesFailed(true);
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
      ...(productContext.current?.mandateId === selectedMandate && productContext.current
        ? { productContext: productContext.current.value }
        : {}),
    };
    setSending(true);
    followLatest.current = true;
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
        request.productContext,
      );
      if (response.productContext !== undefined)
        productContext.current = response.productContext
          ? { mandateId: selectedMandate, value: response.productContext }
          : null;
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
      if (cause instanceof ShoppingAgentApiError && cause.code === "SHOPPING_SELECTION_EXPIRED") {
        productContext.current = null;
        setRetry(null);
        setMessage(request.message);
      } else setRetry(request);
      setError(
        cause instanceof Error
          ? cause.message
          : "The shopping agent could not complete the request.",
      );
    } finally {
      setSending(false);
    }
  }

  const selected = mandates.find((mandate) => mandate.id === mandateId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border py-4 sm:py-5">
        <h1 className="text-lg font-medium tracking-[-0.02em]">Shopping assistant</h1>
        <div className="flex items-center gap-1">
          {messages.length ? (
            <button
              type="button"
              disabled={sending}
              onClick={() => {
                setMessages([]);
                productContext.current = null;
                setMessage("");
                setRetry(null);
                setError(null);
                followLatest.current = true;
                composer.current?.focus();
              }}
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "px-2 text-xs sm:text-sm",
              )}
            >
              New brief
            </button>
          ) : null}
          <Link
            href={mandateId ? `/discover?mandate=${encodeURIComponent(mandateId)}` : "/discover"}
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "px-2 text-xs sm:text-sm",
            )}
          >
            Browse products <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </header>
      {!loadingMandates && mandates.length ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-border py-3">
          <label className="flex w-full min-w-0 items-center gap-3 text-xs font-medium sm:w-auto sm:flex-none">
            Mandate
            <select
              value={mandateId}
              onChange={(event) => {
                productContext.current = null;
                setRetry(null);
                setError(null);
                setMandateId(event.currentTarget.value);
              }}
              disabled={sending}
              className={cn(workspaceField, "h-10 sm:w-72")}
            >
              <option value="">Choose a mandate · optional for refunds</option>
              {mandates.map((mandate) => (
                <option key={mandate.id} value={mandate.id}>
                  {mandate.title} · v{mandate.version}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs leading-5 text-muted-foreground">
            {selected ? (
              <>
                Maximum {formatUsdLabel(selected.rules.transactionLimit)} ·{" "}
                {selected.rules.autoSpendLimit === 0
                  ? "Approval required before every purchase"
                  : `Automatic limit ${formatUsdLabel(selected.rules.autoSpendLimit)}`}
              </>
            ) : (
              "Choose permissions before shopping. Refunds don’t need a mandate."
            )}
          </p>
        </div>
      ) : null}
      <div
        ref={thread}
        role="log"
        aria-label="Shopping conversation"
        aria-live="polite"
        aria-relevant="additions"
        tabIndex={0}
        onScroll={() => {
          const element = thread.current;
          if (!element) return;
          const previous = threadLayout.current;
          const changed =
            previous &&
            (previous.width !== element.clientWidth ||
              previous.height !== element.clientHeight ||
              previous.contentHeight !== element.scrollHeight);
          if (changed && followLatest.current) element.scrollTop = element.scrollHeight;
          threadLayout.current = {
            width: element.clientWidth,
            height: element.clientHeight,
            contentHeight: element.scrollHeight,
          };
          const away = element.scrollHeight - element.scrollTop - element.clientHeight > 80;
          followLatest.current = !away;
          setAwayFromLatest(away);
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-6 [scrollbar-gutter:stable] sm:py-8"
      >
        <div ref={threadContent} className="mx-auto max-w-[760px] space-y-7 px-1 sm:px-3">
          {loadingMandates ? (
            <WorkspaceLoading label="Loading active mandates…" />
          ) : messages.length ? (
            messages.map((item) => <AgentMessage key={item.id} message={item} />)
          ) : (
            <div className="flex min-h-56 flex-col items-center justify-center py-6 text-center sm:min-h-72">
              <Bot
                size={26}
                strokeWidth={1.5}
                className="text-muted-foreground"
                aria-hidden="true"
              />
              <h2 className="mt-5 font-editorial text-[28px] leading-tight tracking-[-0.025em] sm:text-3xl">
                Your shopping brief starts here.
              </h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                {mandates.length
                  ? "Tell me what you need. I’ll help compare options and prepare a proposal for your review."
                  : "Create a mandate to set your shopping permissions. You can also ask about a previous purchase or prepare a refund."}
              </p>
              {!mandates.length && !mandatesFailed ? (
                <Link
                  href="/mandates/new"
                  className={cn(buttonVariants({ variant: "outline" }), "mt-5")}
                >
                  Create a mandate
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              ) : (
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {["Compare options within my budget", "Help me refund a previous purchase"].map(
                    (prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => {
                          setMessage(prompt);
                          composer.current?.focus();
                        }}
                        className="min-h-11 rounded-lg border border-border bg-card px-3 text-xs transition-colors hover:bg-secondary"
                      >
                        {prompt}
                        <ArrowRight size={12} className="ml-2 inline" aria-hidden="true" />
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          )}
          {sending ? (
            <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle
                size={16}
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              Finding the next step…
            </div>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-border bg-secondary px-4 py-3 text-sm leading-6"
            >
              <p className="flex items-start gap-2">
                <CircleAlert size={17} className="mt-1 shrink-0" aria-hidden="true" />
                {error}
              </p>
              {mandatesFailed ? (
                <button
                  type="button"
                  onClick={() => void loadMandates()}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-3")}
                >
                  Reload mandates
                </button>
              ) : null}
              {retry ? (
                <button
                  type="button"
                  onClick={() => void send(retry.message, retry)}
                  disabled={sending}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-3")}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  Retry same request
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mx-auto w-full max-w-[784px] shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
        {awayFromLatest && messages.length ? (
          <div className="mb-2 flex justify-center">
            <button
              type="button"
              onClick={() => {
                if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
                followLatest.current = true;
                setAwayFromLatest(false);
              }}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              <ArrowDown size={14} aria-hidden="true" />
              Jump to latest
            </button>
          </div>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          className="rounded-xl border border-border bg-card p-3 sm:p-4"
        >
          <label htmlFor="shopping-message" className="sr-only">
            Message the shopping agent
          </label>
          <textarea
            ref={composer}
            id="shopping-message"
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
            disabled={sending || loadingMandates || mandatesFailed}
            rows={2}
            maxLength={1000}
            placeholder={
              mandateId
                ? "What would you like to find?"
                : "Ask about a purchase or prepare a refund…"
            }
            className="max-h-40 min-h-14 w-full resize-none rounded-md bg-transparent px-1 text-sm leading-6 placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-[11px] leading-4 text-muted-foreground">
              {sending ? "Working on your request" : "Review every proposal before checkout."}
              <span className="ml-2 hidden sm:inline">Ctrl or ⌘ + Enter to send</span>
            </p>
            <button
              type="submit"
              disabled={sending || loadingMandates || mandatesFailed || !message.trim()}
              className={cn(buttonVariants({ size: "sm" }), "h-11 rounded-lg")}
            >
              <Send size={15} aria-hidden="true" />
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
