"use client";

import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, LoaderCircle, Wallet } from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { formatUtcDate } from "@/lib/mandates/money";
import {
  cancelSavedPayPal,
  completeSavedPayPal,
  getAutopayPreview,
  getSavedPayPal,
  removeSavedPayPal,
  startSavedPayPal,
  type AutopayPreview,
  type SavedPayPal,
} from "@/lib/payments/payment-methods";
import { WorkspaceNotice } from "@/components/workspace-ui";

// Long consent labels must wrap inside the card on 320px screens instead of overflowing.
const WRAPPING_BUTTON = "h-auto min-h-11 max-w-full whitespace-normal py-2.5 text-center";

function message(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Settings card for PayPal Vault consent. The PayPal payment token never
 * reaches the browser; only a status and a masked payer email do.
 */
export function SavedPayPalMethod() {
  const router = useRouter();
  const id = useId();
  const consentId = `${id}-consent`;
  const [method, setMethod] = useState<SavedPayPal | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [consent, setConsent] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const result = new URLSearchParams(window.location.search).get("vault");
    const load =
      result === "return"
        ? completeSavedPayPal()
        : result === "cancel"
          ? cancelSavedPayPal()
          : getSavedPayPal();
    load
      .then((value) => {
        if (!active) return;
        setMethod(value);
        if (result === "return" && value.status === "ACTIVE") {
          setNotice("PayPal is saved. AgentGuard-allowed purchases can now be paid automatically.");
        }
        if (result === "cancel") setNotice("PayPal approval was cancelled. Nothing was saved.");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(message(cause, "We couldn’t load your saved PayPal."));
        if (result)
          void getSavedPayPal().then(
            (value) => active && setMethod(value),
            () => {},
          );
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
        if (result) router.replace("/settings", { scroll: false });
      });
    return () => {
      active = false;
    };
  }, [router]);

  const save = useCallback(async () => {
    if (!consent || busy) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const started = await startSavedPayPal();
      setMethod(started.paymentMethod);
      if (started.approvalUrl) {
        window.location.assign(started.approvalUrl);
        return;
      }
      setBusy(null);
    } catch (cause) {
      setError(message(cause, "We couldn’t start PayPal approval. Try again."));
      setBusy(null);
    }
  }, [busy, consent]);

  const remove = useCallback(async () => {
    if (busy) return;
    setBusy("remove");
    setError(null);
    setNotice(null);
    try {
      const removed = await removeSavedPayPal();
      setMethod(removed);
      setConfirmRemove(false);
      setConsent(false);
      setNotice(
        removed.status === "REMOVAL_PENDING"
          ? "Removal requested. MandatePay will not use it; PayPal has not confirmed yet."
          : "Your saved PayPal was removed.",
      );
    } catch (cause) {
      setError(message(cause, "We couldn’t remove your saved PayPal. Try again."));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const status = method?.status ?? "NONE";
  const saved = status === "ACTIVE";
  const removing = status === "REMOVAL_PENDING";

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-6"
    >
      <div className="flex items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-sand">
          <Wallet size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="text-lg font-medium leading-6">
            Save PayPal for autonomous purchases
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            With your consent, PayPal keeps a payment method for MandatePay so an allowed purchase
            can be paid without sending you to PayPal each time. It only covers purchases that meet
            every condition below.
          </p>
          <ul className="mt-4 max-w-xl list-disc space-y-1.5 pl-5 text-sm leading-6">
            <li>AgentGuard allows the purchase under one of your active mandates.</li>
            <li>The total is within that mandate’s automatic limit.</li>
            <li>Automatic purchase permissions are on.</li>
            <li>
              Anything that needs your approval, or is blocked, never uses it. You can remove it
              here or in PayPal at any time.
            </li>
          </ul>

          <div className="mt-5" aria-live="polite">
            {loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                Checking your saved PayPal…
              </p>
            ) : saved ? (
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <Check size={16} aria-hidden="true" /> Saved PayPal
                {method?.payerEmail ? ` · ${method.payerEmail}` : ""}
                {method?.activatedAt ? (
                  <span className="font-normal text-muted-foreground">
                    · since {formatUtcDate(method.activatedAt)}
                  </span>
                ) : null}
              </p>
            ) : removing ? (
              <p className="text-sm leading-6">
                Removal requested. MandatePay will not use this PayPal method; PayPal has not
                confirmed the removal yet.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">No PayPal method is saved.</p>
            )}
          </div>

          {notice ? (
            <div className="mt-4">
              <WorkspaceNotice>{notice}</WorkspaceNotice>
            </div>
          ) : null}
          {error ? (
            <div className="mt-4">
              <WorkspaceNotice error>{error}</WorkspaceNotice>
            </div>
          ) : null}
          {!loading && method && !method.available && !saved && !removing ? (
            <div className="mt-4">
              <WorkspaceNotice>
                Saving PayPal is not available on this server yet. Checkout with PayPal approval
                still works.
              </WorkspaceNotice>
            </div>
          ) : null}

          {!loading && !saved && !removing ? (
            <div className="mt-5 space-y-4 border-t border-border pt-5">
              <label htmlFor={consentId} className="flex min-h-11 items-start gap-3 text-sm">
                <input
                  id={consentId}
                  type="checkbox"
                  checked={consent}
                  disabled={busy !== null || method?.available === false}
                  onChange={(event) => setConsent(event.currentTarget.checked)}
                  className="mt-1 size-4 shrink-0 accent-primary"
                />
                <span className="leading-6">
                  I allow MandatePay to charge my saved PayPal for purchases AgentGuard allows
                  within my automatic limit, until I remove it.
                </span>
              </label>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!consent || busy !== null || method?.available === false}
                className={cn(buttonVariants(), WRAPPING_BUTTON)}
              >
                {busy === "save" ? (
                  <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                ) : null}
                {busy === "save" ? "Opening PayPal…" : "Save PayPal with PayPal approval"}
              </button>
            </div>
          ) : null}

          {!loading && (saved || removing) ? (
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-5">
              {confirmRemove || removing ? (
                <>
                  {!removing ? (
                    <p className="w-full text-sm leading-6">
                      Remove your saved PayPal? Allowed purchases will go back to PayPal checkout
                      with your approval.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void remove()}
                    disabled={busy !== null}
                    className={cn(buttonVariants({ variant: "outline" }), WRAPPING_BUTTON)}
                  >
                    {busy === "remove" ? (
                      <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                    ) : null}
                    {removing ? "Retry removal" : "Yes, remove saved PayPal"}
                  </button>
                  {!removing ? (
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(false)}
                      disabled={busy !== null}
                      className={cn(buttonVariants({ variant: "ghost" }), WRAPPING_BUTTON)}
                    >
                      Keep it
                    </button>
                  ) : null}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRemove(true)}
                  className={cn(buttonVariants({ variant: "outline" }), WRAPPING_BUTTON)}
                >
                  Remove saved PayPal
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

const PAID_STATUSES = new Set(["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED", "REVERSED"]);
const WATCHED_PROPOSAL_STATUSES = new Set([
  "AUTHORIZED",
  "PAYMENT_PENDING",
  "PAYPAL_ORDER_CREATED",
  "COMPLETED",
]);

/**
 * Proposal-card line for an AgentGuard ALLOW proposal: a server-confirmed
 * automatic payment receipt, or a pointer to Settings when nothing is saved.
 */
export function AutopayNotice({
  proposalId,
  status,
  decision,
}: {
  proposalId: string;
  status: string;
  decision: string | null | undefined;
}) {
  const watched = decision === "ALLOW" && WATCHED_PROPOSAL_STATUSES.has(status);
  const [preview, setPreview] = useState<AutopayPreview | null>(null);

  useEffect(() => {
    if (!watched) return;
    let active = true;
    getAutopayPreview(proposalId)
      .then((value) => active && setPreview(value))
      .catch(() => active && setPreview(null));
    return () => {
      active = false;
    };
  }, [proposalId, status, watched]);

  if (!watched || !preview) return null;
  const payment = preview.payment;
  if (payment?.paymentSource === "vault") {
    const paid = PAID_STATUSES.has(payment.status);
    return (
      <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {paid ? <Check size={15} aria-hidden="true" /> : null}
        <span className="font-medium">
          {paid
            ? "Paid automatically with your saved PayPal"
            : "Paying with your saved PayPal — waiting for PayPal to confirm"}
        </span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <Link
          href={`/orders/${encodeURIComponent(payment.id)}`}
          className="inline-flex min-h-11 items-center gap-1 font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {paid ? "View receipt" : "View status"} <ArrowRight size={13} aria-hidden="true" />
        </Link>
      </p>
    );
  }
  if (payment && status === "PAYPAL_ORDER_CREATED" && !PAID_STATUSES.has(payment.status)) {
    // PayPal asked for buyer approval, so the automatic attempt fell back to checkout.
    return (
      <p className="mt-4 text-sm leading-6">
        PayPal asked you to approve this payment, so nothing was charged automatically.{" "}
        <Link
          href={`/orders/new?proposalId=${encodeURIComponent(proposalId)}`}
          className="font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Continue to Sandbox checkout
        </Link>
      </p>
    );
  }
  if (status === "AUTHORIZED" && preview.reason === "NO_SAVED_PAYMENT_METHOD") {
    return (
      <p className="mt-4 text-sm leading-6 text-muted-foreground">
        AgentGuard allowed this purchase. To pay purchases like this automatically,{" "}
        <Link
          href="/settings"
          className="font-medium text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          save PayPal in Settings
        </Link>
        .
      </p>
    );
  }
  return null;
}
