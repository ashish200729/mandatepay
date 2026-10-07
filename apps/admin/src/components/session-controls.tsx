"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@mandatepay/ui/components/button";
import { ReauthDialog } from "./admin/reauth-dialog";
import { useAdminToast } from "./admin/toasts";
import { KeyRound, LogOut } from "lucide-react";

export function SessionControls() {
  const router = useRouter(),
    notify = useAdminToast(),
    lock = useRef(false);
  const [pending, setPending] = useState(false),
    [reauth, setReauth] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function signOut() {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/sign-out", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 401) {
        router.replace("/login?state=expired");
        router.refresh();
        return;
      }
      if (response.status === 403) {
        router.replace("/access-denied");
        router.refresh();
        return;
      }
      if (!response.ok) throw new Error();
      router.replace("/login");
      router.refresh();
    } catch {
      setError("Could not sign out. Try again shortly.");
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return (
    <div className="mt-6 space-y-4">
      <ReauthDialog
        open={reauth}
        onOpenChange={setReauth}
        trigger={
          <Button
            variant="outline"
            disabled={pending}
            className="w-full justify-between rounded-lg"
          >
            Confirm password
            <KeyRound size={16} aria-hidden="true" />
          </Button>
        }
        onConfirmed={() =>
          notify({
            title: "Password confirmed",
            message: "Password confirmation is current for ten minutes.",
            tone: "success",
          })
        }
      />
      <Button
        type="button"
        disabled={pending}
        className="w-full justify-between rounded-lg"
        onClick={() => void signOut()}
      >
        {pending ? "Signing out…" : "Sign out"}
        <LogOut size={16} aria-hidden="true" />
      </Button>
      {error && (
        <p role="alert" className="rounded-xl border p-3 text-sm">
          {error}
        </p>
      )}
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          Ending your session…
        </p>
      )}
    </div>
  );
}
