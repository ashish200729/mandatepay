"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import { Button } from "@mandatepay/ui/components/button";
import { AuthClientError, requestPasswordReset, resetPassword } from "@/lib/auth/client";

const inputClassName =
  "mt-2 h-12 w-full rounded-xl border border-border bg-background px-4 text-sm text-foreground outline-hidden placeholder:text-muted-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60";

export function PasswordResetForm({
  mode,
  token,
  invalidToken = false,
}: {
  mode: "request" | "reset";
  token?: string;
  invalidToken?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const isReset = mode === "reset";
  useEffect(() => {
    // Keep bearer reset tokens out of subsequent navigation URLs and browser history.
    if (isReset && token) window.history.replaceState(window.history.state, "", "/reset-password");
  }, [isReset, token]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (isReset && password !== String(form.get("confirmation") ?? "")) {
      setError("Your passwords don’t match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (isReset && token) await resetPassword(token, password);
      else
        await requestPasswordReset(
          String(form.get("email") ?? "").trim(),
          new URL("/reset-password", window.location.origin).href,
        );
      setComplete(true);
    } catch (cause) {
      setError(
        cause instanceof AuthClientError
          ? cause.message
          : "We couldn’t reach MandatePay. Try again in a moment.",
      );
    } finally {
      setPending(false);
    }
  }

  if (complete)
    return (
      <div className="space-y-5">
        <p
          role="status"
          className="rounded-xl border border-border bg-secondary/50 px-4 py-4 text-sm leading-relaxed"
        >
          {isReset
            ? "Your password has been updated and existing sessions have been signed out. Sign in with your new password."
            : "If an account uses that email, you’ll receive a password reset link. Check your inbox and spam folder."}
        </p>
        <Link href="/signin" className="block text-center text-sm underline underline-offset-4">
          Back to sign in
        </Link>
      </div>
    );

  if (isReset && (!token || invalidToken))
    return (
      <div className="space-y-5">
        <p
          role="alert"
          className="rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm leading-relaxed"
        >
          This reset link is invalid or has expired. Request a new link to continue.
        </p>
        <Link
          href="/forgot-password"
          className="block text-center text-sm underline underline-offset-4"
        >
          Request a new reset link
        </Link>
      </div>
    );

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm leading-relaxed"
        >
          {error}
        </p>
      ) : null}
      {isReset ? (
        <>
          <label className="block text-sm font-medium">
            New password
            <input
              className={inputClassName}
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
              disabled={pending}
            />
          </label>
          <label className="block text-sm font-medium">
            Confirm password
            <input
              className={inputClassName}
              name="confirmation"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
              disabled={pending}
            />
          </label>
        </>
      ) : (
        <label className="block text-sm font-medium">
          Email
          <input
            className={inputClassName}
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            required
            disabled={pending}
          />
        </label>
      )}
      <Button
        type="submit"
        size="lg"
        className="w-full rounded-xl"
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? <LoaderCircle className="animate-spin" size={16} aria-hidden="true" /> : null}
        {pending ? "Please wait…" : isReset ? "Update password" : "Send reset link"}
      </Button>
      <Link
        href="/signin"
        className="block text-center text-sm text-muted-foreground underline underline-offset-4"
      >
        Back to sign in
      </Link>
    </form>
  );
}
