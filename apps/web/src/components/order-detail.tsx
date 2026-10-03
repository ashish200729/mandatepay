"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, CircleAlert, LoaderCircle, ReceiptText, RotateCcw } from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { AuditTimeline } from "@/components/audit-timeline";
import {
  formatUsdLabel,
  formatUsdMinor,
  formatUtcDate,
  parseUsdDecimal,
} from "@/lib/mandates/money";
import {
  capturePaypalOrder,
  createRefund,
  createRefundRequestKey,
  getOrder,
  PaymentApiError,
} from "@/lib/payments/client";
import { calculateRemainingRefundableMinor } from "@/lib/payments/refunds";
import { consumeRefundDraft } from "@/lib/agent/refund-draft";
import type { PaymentRecord } from "@/lib/payments/types";

function isCaptured(payment: PaymentRecord) {
  return (
    Boolean(payment.paypalCaptureId) ||
    ["COMPLETED", "CAPTURED", "PAYMENT_CAPTURED"].includes(payment.status)
  );
}

type RefundIntent = { amountMinor: number | null; reason: string; requestKey: string };

export function OrderDetail({
  paymentId,
  paypalState,
}: {
  paymentId: string;
  paypalState: string | null;
}) {
  const [payment, setPayment] = useState<PaymentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [refundMode, setRefundMode] = useState<"full" | "partial">("full");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundIntent, setRefundIntent] = useState<RefundIntent | null>(null);
  const [refundConfirm, setRefundConfirm] = useState(false);
  const [refundPending, setRefundPending] = useState(false);
  const [refundNotice, setRefundNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextPayment = await getOrder(paymentId);
      setPayment(nextPayment);
      const draft = consumeRefundDraft(nextPayment.id);
      if (draft) {
        const remaining = calculateRemainingRefundableMinor(
          nextPayment.amount,
          nextPayment.refunds,
        );
        if (
          isCaptured(nextPayment) &&
          remaining > 0 &&
          (draft.amountMinor === null || draft.amountMinor <= remaining)
        ) {
          setRefundMode(draft.amountMinor === null ? "full" : "partial");
          setRefundAmount(draft.amountMinor === null ? "" : formatUsdMinor(draft.amountMinor));
          setRefundReason(draft.reason);
          setRefundNotice(
            "The agent's draft is ready for review. Confirm the details below before requesting a refund.",
          );
        } else {
          setRefundError(
            "This draft no longer matches the refundable payment. Review the current payment and enter new refund details.",
          );
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The payment record could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [paymentId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function capture() {
    if (!payment || capturing || isCaptured(payment)) return;
    setCapturing(true);
    setError(null);
    try {
      setPayment(await capturePaypalOrder(payment.id));
    } catch (cause) {
      setError(
        cause instanceof PaymentApiError && cause.status >= 500
          ? "PayPal Sandbox is temporarily unavailable. The server payment record was not marked complete."
          : cause instanceof Error
            ? cause.message
            : "Capture could not be confirmed.",
      );
    } finally {
      setCapturing(false);
    }
  }

  function resetRefundIntent() {
    setRefundIntent(null);
    setRefundConfirm(false);
    setRefundNotice(null);
    setRefundError(null);
  }

  async function submitRefund(forceRetry = false) {
    if (!payment || !isCaptured(payment) || refundPending) return;
    const remaining = calculateRemainingRefundableMinor(payment.amount, payment.refunds);
    let intent = refundIntent;
    if (!intent) {
      try {
        const amountMinor = refundMode === "full" ? null : parseUsdDecimal(refundAmount);
        if (amountMinor !== null && (amountMinor <= 0 || amountMinor > remaining)) {
          throw new Error(`Enter a partial refund between $0.01 and ${formatUsdLabel(remaining)}.`);
        }
        const reason = refundReason.trim();
        if (!reason) throw new Error("Add a reason for the refund.");
        intent = { amountMinor, reason, requestKey: createRefundRequestKey() };
        setRefundIntent(intent);
      } catch (cause) {
        setRefundError(cause instanceof Error ? cause.message : "Review the refund details.");
        return;
      }
    }
    if (!intent) return;
    if (!refundConfirm && !forceRetry) {
      setRefundConfirm(true);
      return;
    }

    setRefundPending(true);
    setRefundError(null);
    try {
      const result = await createRefund(payment.id, intent);
      setPayment(result.payment);
      setRefundConfirm(false);
      setRefundNotice(
        result.pending
          ? "The server accepted this refund request and marked it pending. Retry with the same details if the provider needs reconciliation."
          : "The server confirmed this refund request.",
      );
      if (!result.pending) {
        setRefundIntent(null);
        setRefundAmount("");
        setRefundReason("");
      }
    } catch (cause) {
      setRefundError(
        cause instanceof Error
          ? cause.message
          : "The refund could not be confirmed. The original request remains available to retry.",
      );
    } finally {
      setRefundPending(false);
    }
  }

  if (loading)
    return (
      <div
        className="flex min-h-56 items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle size={18} className="mr-2 animate-spin" aria-hidden="true" /> Checking server
        payment status…
      </div>
    );
  if (!payment)
    return (
      <div
        className="rounded-2xl border border-destructive/20 bg-destructive/8 p-6 text-sm"
        role="alert"
      >
        <p>{error ?? "Payment not found."}</p>
        <Link href="/orders" className="mt-4 inline-flex font-medium underline underline-offset-4">
          Back to orders
        </Link>
      </div>
    );

  const captured = isCaptured(payment);
  const remaining = calculateRemainingRefundableMinor(payment.amount, payment.refunds);
  const retryPending = Boolean(refundIntent && refundNotice?.includes("pending"));

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
            Payment record
          </p>
          <h1 className="mt-2 font-editorial text-[clamp(2.6rem,5vw,4.8rem)] leading-[1.02] tracking-[-0.035em]">
            {payment.product.title}
          </h1>
          <p className="mt-4 text-base text-muted-foreground">
            {payment.product.brand} · {payment.product.merchant} · {payment.product.condition}
          </p>
        </div>
        <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium">
          {payment.status}
        </span>
      </div>
      <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
        <div className="grid gap-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Amount</p>
            <p className="mt-1 text-lg font-medium tabular-nums">
              {formatUsdLabel(payment.amount)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Created</p>
            <p className="mt-1 font-medium">{formatUtcDate(payment.createdAt)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">PayPal order</p>
            <p className="mt-1 font-medium">{payment.paypalOrderId ?? "Not created"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Capture</p>
            <p className="mt-1 font-medium">{payment.paypalCaptureId ?? "Not confirmed"}</p>
          </div>
        </div>
      </section>
      {paypalState === "cancel" ? (
        <div className="rounded-xl border border-border bg-secondary p-4 text-sm">
          PayPal approval was canceled. The server record above remains authoritative.
        </div>
      ) : null}
      {paypalState === "return" && !captured ? (
        <div className="rounded-2xl border border-sand-border bg-sand p-6">
          <p className="font-medium">PayPal returned you to MandatePay.</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            The server has not confirmed a capture yet. Complete Sandbox payment only after you have
            approved the order in PayPal.
          </p>
          <button
            type="button"
            onClick={() => void capture()}
            disabled={capturing}
            className={cn(buttonVariants({ size: "lg" }), "mt-5")}
          >
            {capturing ? (
              <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <ReceiptText size={16} aria-hidden="true" />
            )}{" "}
            {capturing ? "Confirming capture…" : "Complete Sandbox payment"}
          </button>
        </div>
      ) : null}
      {captured ? (
        <div className="rounded-2xl border border-border bg-card p-6">
          <p className="flex items-center gap-2 font-medium">
            <Check size={17} aria-hidden="true" /> Server confirmed capture
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Capture ID: {payment.paypalCaptureId}
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-secondary p-6 text-sm leading-relaxed">
          <p className="font-medium">Refunds are unavailable until this payment is captured.</p>
          <p className="mt-2 text-muted-foreground">
            The server must confirm a capture before any refund request can be submitted.
          </p>
        </div>
      )}
      {captured ? (
        <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-editorial text-2xl tracking-[-0.02em]">Refund this payment</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Refunds use the captured payment only. The server remains the authority for the
                refundable amount.
              </p>
            </div>
            <span className="rounded-full bg-sand px-3 py-1 text-xs font-medium">
              Remaining {formatUsdLabel(remaining)}
            </span>
          </div>
          {remaining > 0 || retryPending ? (
            <div className="mt-7 space-y-5">
              <div className="flex flex-wrap gap-3 text-sm">
                <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-border px-3 has-[:checked]:border-foreground has-[:checked]:bg-secondary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
                  <input
                    type="radio"
                    name="refund-mode"
                    checked={refundMode === "full"}
                    onChange={() => {
                      setRefundMode("full");
                      resetRefundIntent();
                    }}
                    className="size-4 accent-primary"
                  />{" "}
                  Full refund
                </label>
                <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-border px-3 has-[:checked]:border-foreground has-[:checked]:bg-secondary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
                  <input
                    type="radio"
                    name="refund-mode"
                    checked={refundMode === "partial"}
                    onChange={() => {
                      setRefundMode("partial");
                      resetRefundIntent();
                    }}
                    className="size-4 accent-primary"
                  />{" "}
                  Partial refund
                </label>
              </div>
              {refundMode === "partial" ? (
                <label className="block max-w-xs text-sm font-medium">
                  Refund amount
                  <input
                    value={refundAmount}
                    onChange={(event) => {
                      setRefundAmount(event.currentTarget.value);
                      resetRefundIntent();
                    }}
                    disabled={refundPending || retryPending}
                    inputMode="decimal"
                    placeholder={formatUsdMinor(remaining)}
                    className="mt-2 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-hidden focus:border-foreground/45 focus:ring-4 focus:ring-foreground/8 disabled:opacity-60"
                  />
                </label>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Full refund amount:{" "}
                  <strong className="font-medium text-foreground">
                    {formatUsdLabel(remaining)}
                  </strong>
                </p>
              )}
              <label className="block text-sm font-medium">
                Reason
                <textarea
                  value={refundReason}
                  onChange={(event) => {
                    setRefundReason(event.currentTarget.value);
                    resetRefundIntent();
                  }}
                  disabled={refundPending || retryPending}
                  placeholder="Tell us why this payment should be refunded."
                  className="mt-2 min-h-24 w-full resize-y rounded-xl border border-border bg-background px-3 py-3 text-sm leading-relaxed outline-hidden focus:border-foreground/45 focus:ring-4 focus:ring-foreground/8 disabled:opacity-60"
                />
              </label>
              {refundNotice ? (
                <p
                  className="rounded-xl border border-border bg-secondary px-4 py-3 text-sm"
                  role="status"
                >
                  {refundNotice}
                </p>
              ) : null}
              {refundError ? (
                <p
                  className="rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm"
                  role="alert"
                >
                  {refundError}
                </p>
              ) : null}
              {refundConfirm ? (
                <div
                  className="rounded-xl border border-foreground/15 bg-secondary p-4"
                  role="alertdialog"
                  aria-labelledby="refund-confirm-heading"
                >
                  <h3 id="refund-confirm-heading" className="font-medium">
                    Confirm{" "}
                    {refundMode === "full"
                      ? `a full refund of ${formatUsdLabel(remaining)}`
                      : `a refund of ${refundAmount || "the entered amount"}`}
                    ?
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    This refunds the captured payment for {payment.product.title}. Capture{" "}
                    {payment.paypalCaptureId} remains the original payment reference.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void submitRefund()}
                      disabled={refundPending}
                      className={cn(buttonVariants({ size: "sm" }))}
                    >
                      {refundPending ? (
                        <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <RotateCcw size={15} aria-hidden="true" />
                      )}{" "}
                      {refundPending ? "Submitting…" : "Confirm refund"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRefundConfirm(false)}
                      disabled={refundPending}
                      className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                    >
                      Keep reviewing
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void submitRefund(retryPending)}
                  disabled={refundPending || (!retryPending && !refundReason.trim())}
                  className={cn(buttonVariants({ variant: "outline" }))}
                >
                  {refundPending ? (
                    <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <RotateCcw size={15} aria-hidden="true" />
                  )}{" "}
                  {retryPending ? "Retry pending refund" : "Request refund"}
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-7 rounded-xl border border-border bg-secondary px-4 py-3 text-sm">
              No refundable amount remains according to the server refund history.
            </p>
          )}
          <div className="mt-8 border-t border-border pt-6">
            <h3 className="text-sm font-medium">Refund history</h3>
            {payment.refunds.length ? (
              <div className="mt-4 space-y-3">
                {payment.refunds.map((refund) => (
                  <div
                    key={refund.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-sm"
                  >
                    <span>
                      {refund.status} · {formatUsdLabel(refund.amount)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {refund.paypalRefundId ?? "Provider reference pending"}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No refund requests recorded.</p>
            )}
          </div>
        </section>
      ) : null}
      <AuditTimeline entityId={payment.id} />
      {error ? (
        <div
          className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm"
          role="alert"
        >
          <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : null}
    </div>
  );
}
