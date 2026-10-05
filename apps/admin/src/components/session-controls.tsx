"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@mandatepay/ui/components/button";
export function SessionControls() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  async function post(path: "reauth" | "sign-out", password?: string) {
    if (pending) return;
    setPending(true);
    setMessage(null);
    setFailed(false);
    try {
      const response = await fetch(`/api/admin/${path}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(password === undefined ? {} : { password }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = response.status === 204 ? null : await response.json().catch(() => null);
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
      if (!response.ok)
        throw new Error(data?.error?.message ?? "The request could not be completed. Try again.");
      if (path === "sign-out") {
        router.replace("/login");
        router.refresh();
      } else {
        setMessage("Password confirmed. Password confirmation is current for 10 minutes.");
        router.refresh();
      }
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "The request could not be completed.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="mt-7 space-y-5">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const input = event.currentTarget.elements.namedItem(
            "reauth-password",
          ) as HTMLInputElement;
          const password = input.value;
          input.value = "";
          void post("reauth", password);
        }}
        className="space-y-3 border-t pt-5"
      >
        <label htmlFor="reauth-password" className="block text-sm font-medium">
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
        />
        <Button type="submit" disabled={pending} variant="outline" className="w-full">
          Confirm password
        </Button>
      </form>
      {message && (
        <p role={failed ? "alert" : "status"} className="rounded-xl border p-3 text-sm">
          {message}
        </p>
      )}
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          Updating your session…
        </p>
      )}
      <Button
        type="button"
        disabled={pending}
        onClick={() => void post("sign-out")}
        className="w-full"
      >
        Sign out
      </Button>
    </div>
  );
}
