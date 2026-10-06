"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { requireAdminReason } from "@mandatepay/shared";
import { Button } from "@mandatepay/ui/components/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@mandatepay/ui/components/dialog";
import { AdminActionError, safeActionError } from "@/lib/action-error";
import { ReauthDialog } from "./reauth-dialog";
import { useAdminToast } from "./toasts";

export type ActionConfirmation = {
  reason: string | null;
  confirmation: string | null;
  requestKey: string;
  amountConfirmation?: string | null;
};
export type ActionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  target: { id: string; label: string };
  actionLabel: string;
  trigger?: ReactNode;
  /** Stable operation/version identity. Change only when starting a new verified intent. */
  intentKey?: string;
  amountConfirmation?: { expected: string; label: string };
  reviewItems?: readonly { label: string; value: string }[];
  onConfirm: (input: ActionConfirmation) => Promise<{ status: "success" | "pending" }>;
};
type Risk = "confirm" | "reason" | "high";
function ActionForm({
  props,
  risk,
  freshAuthUntil,
  onBusy,
  previousRequest,
  claimRequest,
  parentBusy,
}: {
  props: ActionDialogProps;
  risk: Risk;
  freshAuthUntil?: string;
  onBusy: (value: boolean) => void;
  previousRequest: ActionConfirmation | null;
  claimRequest: (reason: string | null, confirmation: string | null) => ActionConfirmation;
  parentBusy: boolean;
}) {
  const notify = useAdminToast(),
    lock = useRef(false);
  const [reason, setReason] = useState(previousRequest?.reason ?? ""),
    [typed, setTyped] = useState(previousRequest?.confirmation ?? ""),
    [amount, setAmount] = useState(previousRequest?.amountConfirmation ?? ""),
    [review, setReview] = useState(false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [reauth, setReauth] = useState(false);
  const [confirmedUntil, setConfirmedUntil] = useState(freshAuthUntil);
  const [now, setNow] = useState(() => Date.now()),
    [submitted, setSubmitted] = useState(Boolean(previousRequest));
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const errorElement = useRef<HTMLParagraphElement>(null);
  const fresh =
    Number.isFinite(Date.parse(confirmedUntil ?? "")) && Date.parse(confirmedUntil!) > now;
  function showError(value: string) {
    setError(value);
    requestAnimationFrame(() => errorElement.current?.focus());
  }
  return (
    <>
      <div className="mt-5 rounded-xl border bg-secondary/50 p-4 text-sm">
        <p className="font-medium">{props.target.label}</p>
        <p className="mt-1 break-all text-xs text-muted-foreground">Target: {props.target.id}</p>
        {props.reviewItems?.map((item) => (
          <p key={item.label} className="mt-2 text-sm">
            <span className="text-muted-foreground">{item.label}: </span>
            {item.value}
          </p>
        ))}
      </div>
      <form
        className="mt-5 space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (lock.current || parentBusy) return;
          let safeReason: string | null = null;
          if (risk !== "confirm") {
            try {
              safeReason = requireAdminReason(reason);
            } catch {
              showError(
                "Provide a reason of 1–255 characters without credentials or secret material.",
              );
              return;
            }
          }
          if (risk === "high" && typed !== props.target.id) {
            showError("Type the complete target ID exactly as shown.");
            return;
          }
          if (props.amountConfirmation && amount.trim() !== props.amountConfirmation.expected) {
            showError("Type the reviewed amount exactly as shown.");
            return;
          }
          if (risk === "high" && (!fresh || Date.parse(confirmedUntil!) <= Date.now())) {
            setReauth(true);
            return;
          }
          if (risk === "high" && !review) {
            setError(null);
            setReview(true);
            return;
          }
          lock.current = true;
          setSubmitted(true);
          setPending(true);
          onBusy(true);
          setError(null);
          try {
            const result = await props.onConfirm({
              ...claimRequest(safeReason, risk === "high" ? typed : null),
              amountConfirmation: props.amountConfirmation ? amount.trim() : null,
            });
            if (!result || !["success", "pending"].includes(result.status)) throw new Error();
            notify(
              result.status === "pending"
                ? {
                    title: "Action pending",
                    message:
                      "The outcome is not yet confirmed. Check the current state before retrying.",
                    tone: "info",
                  }
                : {
                    title: "Action completed",
                    message: `${props.actionLabel}: ${props.target.label}`,
                    tone: "success",
                  },
            );
            props.onOpenChange(false);
          } catch (failure) {
            showError(safeActionError(failure));
            if (failure instanceof AdminActionError && failure.code === "fresh-auth")
              setConfirmedUntil(undefined);
          } finally {
            lock.current = false;
            setPending(false);
            onBusy(false);
          }
        }}
      >
        {risk !== "confirm" &&
          (review ? (
            <div>
              <h3 className="text-sm font-medium">Reason</h3>
              <p className="mt-2 break-words rounded-xl border p-3 text-sm">{reason.trim()}</p>
            </div>
          ) : (
            <label className="block text-sm font-medium">
              Reason
              <textarea
                aria-label="Reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
                maxLength={255}
                disabled={pending || submitted}
                rows={3}
                aria-describedby="action-reason-help"
                className="mt-2 w-full rounded-xl border bg-background p-3 text-sm"
              />
              <span
                id="action-reason-help"
                className="mt-1 block text-xs font-normal text-muted-foreground"
              >
                Explain why this action is needed. Do not include credentials or secrets.
              </span>
            </label>
          ))}
        {risk === "high" &&
          (review ? (
            <p className="text-sm">
              Typed confirmation matches{" "}
              <span className="break-all font-medium">{props.target.id}</span>.
            </p>
          ) : (
            <label className="block text-sm font-medium">
              Target confirmation
              <input
                aria-label="Target confirmation"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                disabled={pending || submitted}
                aria-describedby="action-typed-help"
                className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
              />
              <span
                id="action-typed-help"
                className="mt-1 block break-words text-xs font-normal text-muted-foreground"
              >
                Type {props.target.id} exactly to continue.
              </span>
            </label>
          ))}
        {props.amountConfirmation &&
          (review ? (
            <p className="text-sm">
              Reviewed amount is{" "}
              <span className="font-medium">{props.amountConfirmation.expected}</span> USD.
            </p>
          ) : (
            <label className="block text-sm font-medium">
              {props.amountConfirmation.label}
              <input
                aria-label="Amount confirmation"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                disabled={pending || submitted}
                aria-describedby="action-amount-help"
                className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
              />
              <span
                id="action-amount-help"
                className="mt-1 block break-words text-xs font-normal text-muted-foreground"
              >
                Type {props.amountConfirmation.expected} exactly. Refunds do not restore spending
                permission.
              </span>
            </label>
          ))}
        {risk === "high" && !fresh && (
          <div className="rounded-xl border bg-admin-warning p-4">
            <p className="text-sm text-admin-warning-foreground">
              Confirm your password before this sensitive action.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-3"
              onClick={() => setReauth(true)}
            >
              Confirm password
            </Button>
          </div>
        )}
        {review && (
          <p className="rounded-xl border bg-admin-warning p-4 text-sm text-admin-warning-foreground">
            Final review: {props.actionLabel.toLowerCase()} affects this exact target. Confirm only
            after reviewing the reason and current state.
          </p>
        )}
        {error && (
          <p
            ref={errorElement}
            role="alert"
            tabIndex={-1}
            className="rounded-xl border p-3 text-sm text-admin-danger-foreground"
          >
            {error}
          </p>
        )}
        {pending && (
          <p role="status" className="text-sm text-muted-foreground">
            Submitting this action…
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending || parentBusy}>
              Cancel
            </Button>
          </DialogClose>
          {review && (
            <Button
              type="button"
              variant="outline"
              disabled={pending || submitted}
              onClick={() => setReview(false)}
            >
              Edit details
            </Button>
          )}
          <Button
            type="submit"
            disabled={
              pending ||
              parentBusy ||
              (risk !== "confirm" && !reason.trim()) ||
              (risk === "high" && (typed !== props.target.id || !fresh)) ||
              (Boolean(props.amountConfirmation) &&
                amount.trim() !== props.amountConfirmation?.expected)
            }
          >
            {pending
              ? "Submitting…"
              : risk === "high" && !review
                ? "Review action"
                : props.actionLabel}
          </Button>
        </div>
      </form>
      <ReauthDialog
        open={reauth}
        onOpenChange={setReauth}
        onConfirmed={(admin) => {
          setConfirmedUntil(admin.session.freshAuthUntil);
          notify({
            title: "Password confirmed",
            message: "Authentication is current for ten minutes.",
            tone: "success",
          });
        }}
      />
    </>
  );
}
function ActionDialog({
  risk,
  freshAuthUntil,
  ...props
}: ActionDialogProps & { risk: Risk; freshAuthUntil?: string }) {
  const [busy, setBusy] = useState(false);
  const scope = props.intentKey ?? `${props.title}:${props.target.id}`;
  const [previous, setPrevious] = useState<{ scope: string; input: ActionConfirmation } | null>(
    null,
  );
  const request = useRef<{ scope: string; input: ActionConfirmation } | null>(null);
  function claimRequest(reason: string | null, confirmation: string | null) {
    if (request.current?.scope === scope) {
      if (
        request.current.input.reason !== reason ||
        request.current.input.confirmation !== confirmation
      )
        throw new AdminActionError("invalid");
      return request.current.input;
    }
    const next = { scope, input: { reason, confirmation, requestKey: crypto.randomUUID() } };
    request.current = next;
    setPrevious(next);
    return next.input;
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
    >
      {props.trigger && <DialogTrigger asChild>{props.trigger}</DialogTrigger>}
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>{props.description}</DialogDescription>
        <ActionForm
          key={scope}
          props={props}
          risk={risk}
          freshAuthUntil={freshAuthUntil}
          onBusy={setBusy}
          previousRequest={previous?.scope === scope ? previous.input : null}
          claimRequest={claimRequest}
          parentBusy={busy}
        />
      </DialogContent>
    </Dialog>
  );
}
export function ConfirmDialog(props: ActionDialogProps) {
  return <ActionDialog {...props} risk="confirm" />;
}
export function ReasonDialog(props: ActionDialogProps) {
  return <ActionDialog {...props} risk="reason" />;
}
export function DangerConfirmDialog(props: ActionDialogProps & { freshAuthUntil?: string }) {
  return <ActionDialog {...props} risk="high" />;
}
