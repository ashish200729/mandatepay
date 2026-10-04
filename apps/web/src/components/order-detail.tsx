"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, LoaderCircle, ReceiptText, RotateCcw } from "lucide-react";
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
  checkPaymentStatus,
  checkRefundStatus,
  PaymentApiError,
} from "@/lib/payments/client";
import { calculateRemainingRefundableMinor } from "@/lib/payments/refunds";
import { consumeRefundDraft } from "@/lib/agent/refund-draft";
import type { PaymentRecord } from "@/lib/payments/types";
import {
  workspaceField,
  WorkspaceLoading,
  WorkspaceNotice,
  WorkspaceStatus,
  WorkspaceSteps,
} from "@/components/workspace-ui";

function isCaptured(payment: PaymentRecord) {
  return ["COMPLETED", "CAPTURED", "PAYMENT_CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(
    payment.status,
  );
}

type RefundIntent = {
  amountMinor: number | null;
  reason: string;
  requestKey: string;
  displayAmountMinor: number;
  refundId?: string;
};

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
  const [paymentChecking, setPaymentChecking] = useState(false);
  const [paymentChecked, setPaymentChecked] = useState(false);
  const [captureAwaitingConfirmation, setCaptureAwaitingConfirmation] = useState(false);
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [refundMode, setRefundMode] = useState<"full" | "partial">("full");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundIntent, setRefundIntent] = useState<RefundIntent | null>(null);
  const [refundConfirm, setRefundConfirm] = useState(false);
  const [refundPending, setRefundPending] = useState(false);
  const [refundRefreshing, setRefundRefreshing] = useState(false);
  const [refundAwaitingConfirmation, setRefundAwaitingConfirmation] = useState(false);
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

  useEffect(() => {
    if (!payment?.authorizationExpiresAt) return;
    const deadline = Date.parse(payment.authorizationExpiresAt);
    if (deadline <= clockNow) return;
    const remaining = deadline - Date.now();
    const timer = setTimeout(
      () => setClockNow(Date.now()),
      Math.max(0, Math.min(remaining + 1, 2_147_483_647)),
    );
    return () => clearTimeout(timer);
  }, [payment?.authorizationExpiresAt, clockNow]);

  async function refreshPaymentStatus() {
    if (!payment || paymentChecking || capturing) return;
    setPaymentChecking(true);
    setError(null);
    try {
      const current = await checkPaymentStatus(payment.id);
      setPayment(current);
      setPaymentChecked(true);
      setCaptureAwaitingConfirmation(current.status === "CAPTURE_PENDING");
      setPaymentNotice(
        current.status === "CAPTURE_PENDING"
          ? "The capture is still awaiting confirmation. You can check its status again."
          : "The latest payment status is shown below.",
      );
    } catch {
      setError(
        "The payment status could not be checked. Check again before submitting another payment request.",
      );
    } finally {
      setPaymentChecking(false);
    }
  }

  async function capture() {
    if (!payment || capturing || paymentChecking || isCaptured(payment)) return;
    if (
      payment.authorizationExpiresAt &&
      Date.parse(payment.authorizationExpiresAt) <= Date.now()
    ) {
      setClockNow(Date.now());
      setError(
        "This payment authorization expired. Prepare and approve a new proposal before paying.",
      );
      return;
    }
    setCapturing(true);
    setCaptureAwaitingConfirmation(true);
    setError(null);
    try {
      const current = await capturePaypalOrder(payment.id);
      setPayment(current);
      setCaptureAwaitingConfirmation(current.status === "CAPTURE_PENDING");
    } catch (cause) {
      setCaptureAwaitingConfirmation(!(cause instanceof PaymentApiError) || cause.status >= 500);
      setError(
        cause instanceof PaymentApiError && cause.status >= 500
          ? "The payment outcome has not been confirmed. Refresh this order before retrying."
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
    setRefundAwaitingConfirmation(false);
  }

  async function refreshRefundStatus() {
    if (!payment || refundPending || refundRefreshing) return;
    setRefundRefreshing(true);
    setRefundError(null);
    try {
      const current = await checkRefundStatus(payment.id);
      setPayment(current);
      setRefundConfirm(false);
      const pending = current.refunds.some((refund) =>
        ["REQUESTED", "APPROVED", "SUBMITTED"].includes(refund.status),
      );
      if (
        current.status === "REFUNDED" ||
        (refundIntent?.refundId &&
          current.refunds.some(
            (refund) => refund.id === refundIntent.refundId && refund.status === "COMPLETED",
          ))
      ) {
        setRefundIntent(null);
        setRefundAwaitingConfirmation(false);
        setRefundNotice("The server updated this order’s refund status.");
      } else {
        setRefundNotice(
          pending
            ? "A refund is awaiting confirmation. Check its status again before retrying."
            : "The latest refund status is shown below.",
        );
      }
    } catch {
      setRefundError(
        "The refund status could not be checked. Try checking again before submitting another refund.",
      );
    } finally {
      setRefundRefreshing(false);
    }
  }

  async function submitRefund(forceRetry = false) {
    if (!payment || !isCaptured(payment) || refundPending || refundRefreshing) return;
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
        intent = {
          amountMinor,
          reason,
          requestKey: createRefundRequestKey(),
          displayAmountMinor: amountMinor ?? remaining,
        };
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
      const result = await createRefund(payment.id, {
        amountMinor: intent.amountMinor,
        reason: intent.reason,
        requestKey: intent.requestKey,
      });
      setPayment(result.payment);
      setRefundConfirm(false);
      setRefundAwaitingConfirmation(result.pending);
      if (result.pending) setRefundIntent({ ...intent, refundId: result.refund.id });
      setRefundNotice(
        result.pending
          ? "The server accepted this refund request and marked it pending. Retry with the same details if the provider needs reconciliation."
          : result.refund.status === "FAILED" || result.refund.status === "CANCELLED"
            ? "PayPal did not complete this refund. Review its status below."
            : "The server confirmed this refund request.",
      );
      if (!result.pending) {
        setRefundIntent(null);
        setRefundAmount("");
        setRefundReason("");
      }
    } catch (cause) {
      setRefundConfirm(false);
      setRefundAwaitingConfirmation(!(cause instanceof PaymentApiError) || cause.status >= 500);
      setRefundError(
        cause instanceof Error
          ? cause.message
          : "The refund could not be confirmed. The original request remains available to retry.",
      );
    } finally {
      setRefundPending(false);
    }
  }

  if (loading) return <WorkspaceLoading label="Checking server payment status…" />;
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
  const approved = payment.status === "APPROVED";
  const expired = Boolean(
    payment.authorizationExpiresAt && Date.parse(payment.authorizationExpiresAt) <= clockNow,
  );
  const capturePending = payment.status === "CAPTURE_PENDING";
  const captureUncertain = capturePending || capturing || captureAwaitingConfirmation;
  const canConfirmPayment =
    !captured &&
    !expired &&
    Boolean(payment.paypalOrderId) &&
    ["CREATED", "APPROVED", "CAPTURE_PENDING"].includes(payment.status) &&
    (approved || (capturePending ? paymentChecked : paypalState === "return"));
  const remaining = calculateRemainingRefundableMinor(payment.amount, payment.refunds);
  const retryPending = Boolean(refundIntent && refundAwaitingConfirmation);
  const refundBusy = refundPending || refundRefreshing;
  const pendingRefunds = payment.refunds.some((refund) =>
    ["REQUESTED", "APPROVED", "SUBMITTED"].includes(refund.status),
  );

  return (
    <div className="space-y-7">
      <Link
        href="/orders"
        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Orders
      </Link>
      <WorkspaceSteps
        steps={["Proposal authorized", "PayPal approval", "Payment recorded"]}
        current={captured ? 2 : 1}
      />
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0 flex-1 basis-80">
          <h1 className="break-words font-editorial text-3xl leading-tight tracking-[-0.025em] sm:text-[40px]">
            {payment.product.title}
          </h1>
          <p className="mt-3 break-words text-sm leading-6 text-muted-foreground">
            {payment.product.brand} · {payment.product.merchant} · {payment.product.condition}
          </p>
        </div>
        <WorkspaceStatus value={payment.status} />
      </div>
      {error ? <WorkspaceNotice error>{error}</WorkspaceNotice> : null}
      {paymentNotice ? <WorkspaceNotice>{paymentNotice}</WorkspaceNotice> : null}
      <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
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
            <p className="mt-1 break-all font-medium">{payment.paypalOrderId ?? "Not created"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Capture</p>
            <p className="mt-1 break-all font-medium">
              {payment.paypalCaptureId ?? "Not confirmed"}
            </p>
          </div>
        </div>
      </section>
      {!captured &&
      payment.paypalOrderId &&
      ["CREATED", "APPROVED", "CAPTURE_PENDING"].includes(payment.status) ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void refreshPaymentStatus()}
            disabled={paymentChecking || capturing}
            className={buttonVariants({ variant: "outline" })}
          >
            {paymentChecking ? "Checking payment status…" : "Check payment status"}
          </button>
          {payment.authorizationExpiresAt ? (
            <p className="text-sm text-muted-foreground">
              Authorization expires {formatUtcDate(payment.authorizationExpiresAt)}
            </p>
          ) : null}
        </div>
      ) : null}
      {expired && !captured ? (
        <WorkspaceNotice>
          {captureUncertain
            ? "The authorization expired while capture confirmation is pending. Check the existing payment status before starting another purchase."
            : "This payment authorization expired. Prepare and approve a new proposal before paying."}
          {!captureUncertain ? (
            <Link
              href="/discover"
              className="ml-2 font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Start a new proposal
            </Link>
          ) : null}
        </WorkspaceNotice>
      ) : null}
      {!captured && !payment.paypalOrderId && payment.status === "CREATED" && !expired ? (
        <WorkspaceNotice>
          PayPal order creation has not been confirmed. Return to checkout to retry the existing
          request.
          <Link
            href={`/orders/new?proposalId=${encodeURIComponent(payment.proposalId)}`}
            className="ml-2 font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Return to checkout
          </Link>
        </WorkspaceNotice>
      ) : null}
      {paypalState === "cancel" ? (
        <div className="rounded-xl border border-border bg-secondary p-4 text-sm">
          PayPal approval was canceled. The server record above remains authoritative.
        </div>
      ) : null}
      {canConfirmPayment ? (
        <div className="rounded-2xl border border-sand-border bg-sand p-6">
          <p className="font-medium">
            {approved ? "PayPal approved this order." : "PayPal returned you to MandatePay."}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {approved
              ? "Complete Sandbox payment to capture the approved amount. Your payment is not complete yet."
              : "The server has not confirmed a capture yet. Complete Sandbox payment only after you have approved the order in PayPal."}
          </p>
          <button
            type="button"
            onClick={() => void capture()}
            disabled={capturing || paymentChecking}
            className={cn(buttonVariants({ size: "lg" }), "mt-5")}
          >
            {capturing ? (
              <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <ReceiptText size={16} aria-hidden="true" />
            )}{" "}
            {capturing
              ? "Confirming capture…"
              : capturePending
                ? "Retry same capture"
                : "Complete Sandbox payment"}
          </button>
        </div>
      ) : null}
      {captured ? (
        <div className="rounded-2xl border border-border bg-card p-6">
          <p className="flex items-center gap-2 font-medium">
            <Check size={17} aria-hidden="true" /> Server confirmed capture
          </p>
          <p className="mt-2 break-all text-sm text-muted-foreground">
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
      <div
        className={cn("grid items-start gap-6", captured && "xl:grid-cols-[minmax(0,1fr)_340px]")}
      >
        {captured ? (
          <section className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-medium">Refund this payment</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Refunds use the captured payment only. The server remains the authority for the
                  refundable amount.
                </p>
              </div>
              <span className="rounded-full bg-sand px-3 py-1 text-xs font-medium">
                Remaining {formatUsdLabel(remaining)}
              </span>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void refreshRefundStatus()}
                disabled={refundBusy}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                {refundRefreshing ? "Checking refund status…" : "Check refund status"}
              </button>
              {pendingRefunds ? (
                <p className="text-sm text-muted-foreground">A refund is awaiting confirmation.</p>
              ) : null}
            </div>
            {refundNotice ? (
              <p
                className="mt-4 rounded-xl border border-border bg-secondary px-4 py-3 text-sm"
                role="status"
              >
                {refundNotice}
              </p>
            ) : null}
            {refundError ? (
              <p
                className="mt-4 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm"
                role="alert"
              >
                {refundError}
              </p>
            ) : null}
            {remaining > 0 || retryPending ? (
              <div className="mt-7 space-y-5">
                <div className="flex flex-wrap gap-3 text-sm">
                  <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-border px-3 has-[:checked]:border-foreground has-[:checked]:bg-secondary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
                    <input
                      type="radio"
                      name="refund-mode"
                      disabled={refundBusy || retryPending}
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
                      disabled={refundBusy || retryPending}
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
                      disabled={refundBusy || retryPending}
                      inputMode="decimal"
                      placeholder={formatUsdMinor(remaining)}
                      className={cn(workspaceField, "mt-2")}
                    />
                  </label>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Full refund amount:{" "}
                    <strong className="font-medium text-foreground">
                      {formatUsdLabel(refundIntent?.displayAmountMinor ?? remaining)}
                    </strong>
                  </p>
                )}
                <div>
                  <label htmlFor="refund-reason" className="block text-sm font-medium">
                    Reason
                  </label>
                  <textarea
                    id="refund-reason"
                    value={refundReason}
                    onChange={(event) => {
                      setRefundReason(event.currentTarget.value);
                      resetRefundIntent();
                    }}
                    disabled={refundBusy || retryPending}
                    maxLength={255}
                    placeholder="Tell us why this payment should be refunded."
                    className="mt-2 min-h-24 w-full resize-y rounded-lg border border-border bg-background px-3 py-3 text-sm leading-6 placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </div>
                {refundConfirm ? (
                  <div
                    className="rounded-xl border border-foreground/15 bg-secondary p-4"
                    role="alertdialog"
                    aria-labelledby="refund-confirm-heading"
                  >
                    <h3 id="refund-confirm-heading" className="font-medium">
                      Confirm{" "}
                      {refundMode === "full"
                        ? `a full refund of ${formatUsdLabel(refundIntent?.displayAmountMinor ?? remaining)}`
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
                        disabled={refundBusy}
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
                        disabled={refundBusy}
                        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                      >
                        Keep reviewing
                      </button>
                    </div>
                  </div>
                ) : null}
                {!refundConfirm ? (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => void submitRefund(retryPending)}
                      disabled={refundBusy || (!retryPending && !refundReason.trim())}
                      className={cn(buttonVariants({ variant: "outline" }))}
                    >
                      {refundPending ? (
                        <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <RotateCcw size={15} aria-hidden="true" />
                      )}{" "}
                      {retryPending ? "Retry same refund" : "Request refund"}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-7 rounded-xl border border-border bg-secondary px-4 py-3 text-sm">
                {pendingRefunds
                  ? "The remaining amount is reserved by a pending refund. Check its status before requesting another refund."
                  : "No refundable amount remains according to the server refund history."}
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
      </div>
    </div>
  );
}
