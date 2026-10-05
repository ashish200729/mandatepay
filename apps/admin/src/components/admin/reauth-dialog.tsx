"use client";
import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@mandatepay/ui/components/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@mandatepay/ui/components/dialog";
import { parseAdminMe, type AdminMe } from "@/lib/session";

function ReauthForm({
  onConfirmed,
  close,
  onBusy,
}: {
  onConfirmed: (admin: AdminMe) => void;
  close: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const router = useRouter();
  const lock = useRef(false);
  const errorElement = useRef<HTMLParagraphElement>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (lock.current) return;
        const input = event.currentTarget.elements.namedItem("reauth-password") as HTMLInputElement;
        const password = input.value;
        input.value = "";
        lock.current = true;
        setPending(true);
        onBusy(true);
        setError(null);
        try {
          const response = await fetch("/api/admin/reauth", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password }),
            signal: AbortSignal.timeout(20_000),
          });
          const data = await response.json().catch(() => null);
          if (
            response.status === 403 ||
            (response.status === 401 && data?.error?.code !== "ADMIN_SIGN_IN_REJECTED")
          ) {
            router.replace(response.status === 401 ? "/login?state=expired" : "/access-denied");
            router.refresh();
            return;
          }
          const admin = response.ok ? parseAdminMe(data) : null;
          if (!admin) throw new Error();
          onConfirmed(admin);
          close();
          router.refresh();
        } catch {
          setError("Password confirmation failed. Check your password or try again shortly.");
          requestAnimationFrame(() => errorElement.current?.focus());
        } finally {
          lock.current = false;
          setPending(false);
          onBusy(false);
        }
      }}
    >
      <label className="block text-sm font-medium" htmlFor="reauth-password">
        Confirm your password
      </label>
      <input
        id="reauth-password"
        name="reauth-password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={128}
        disabled={pending}
        className="h-12 w-full rounded-xl border bg-background px-3"
        aria-describedby={error ? "reauth-error" : undefined}
        aria-invalid={Boolean(error)}
      />
      {error && (
        <p
          ref={errorElement}
          id="reauth-error"
          role="alert"
          tabIndex={-1}
          className="rounded-xl border p-3 text-sm text-admin-danger-foreground"
        >
          {error}
        </p>
      )}
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          Confirming your password…
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? "Confirming…" : "Confirm password"}
        </Button>
      </div>
    </form>
  );
}
export function ReauthDialog({
  open,
  onOpenChange,
  onConfirmed,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed: (admin: AdminMe) => void;
  trigger?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogTitle>Confirm your password</DialogTitle>
        <DialogDescription>
          This refreshes your admin authentication for ten minutes. Your current session is replaced
          after successful confirmation.
        </DialogDescription>
        <ReauthForm close={() => onOpenChange(false)} onConfirmed={onConfirmed} onBusy={setBusy} />
      </DialogContent>
    </Dialog>
  );
}
