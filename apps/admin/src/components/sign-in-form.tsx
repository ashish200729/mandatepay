"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@mandatepay/ui/components/button";

export function SignInForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const form = event.currentTarget;
    const fields = new FormData(form);
    const password = fields.get("password");
    (form.elements.namedItem("password") as HTMLInputElement).value = "";
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: fields.get("email"), password }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error?.message ?? "Unable to sign in. Try again shortly.");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Administration is temporarily unavailable. Try again shortly.");
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          maxLength={320}
          disabled={pending}
          className="mt-2 h-12 w-full rounded-xl border bg-background px-3 disabled:opacity-60"
        />
      </div>
      <div>
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
          disabled={pending}
          aria-describedby={error ? "sign-in-error" : undefined}
          className="mt-2 h-12 w-full rounded-xl border bg-background px-3 disabled:opacity-60"
        />
      </div>
      {error && (
        <p
          id="sign-in-error"
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in to admin"}
      </Button>
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          Checking your credentials and admin access…
        </p>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        Use the verified account configured as the main administrator.
      </p>
    </form>
  );
}
