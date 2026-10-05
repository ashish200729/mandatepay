"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { Button } from "@mandatepay/ui/components/button";
import { AuthClientError, sendVerificationEmail, signIn, signUp } from "@/lib/auth/client";
import { getAuthLink, getSafeReturnTo } from "@/lib/auth/return-to";

const inputClassName =
  "h-11 w-full rounded-xl border border-border/80 bg-background px-3.5 text-sm text-foreground outline-hidden transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

export function AuthForm({ mode, returnTo }: { mode: "sign-in" | "sign-up"; returnTo: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const router = useRouter();
  const safeReturnTo = getSafeReturnTo(returnTo);
  const isSignUp = mode === "sign-up";
  function verificationCallback() {
    return new URL(
      `/verify-email?returnTo=${encodeURIComponent(safeReturnTo)}`,
      window.location.origin,
    ).href;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim();

    setError(null);
    setPending(true);

    try {
      if (isSignUp) {
        const response = await signUp({
          name,
          email,
          password,
          callbackURL: verificationCallback(),
        });
        if (!response?.token) {
          setVerificationEmail(email);
          setPending(false);
          return;
        }
      } else {
        await signIn({ email, password, callbackURL: verificationCallback() });
      }

      router.replace(safeReturnTo);
    } catch (cause) {
      if (cause instanceof AuthClientError && cause.code === "EMAIL_NOT_VERIFIED") {
        setVerificationEmail(email);
        setPending(false);
        return;
      }
      setError(
        cause instanceof AuthClientError
          ? cause.message
          : "We couldn’t reach MandatePay. Try again in a moment.",
      );
      setPending(false);
    }
  }

  const alternatePath = isSignUp ? "/signin" : "/signup";
  const alternateLabel = isSignUp ? "Sign in" : "Create an account";

  if (verificationEmail) {
    return (
      <div className="space-y-4">
        <p
          role="status"
          className="rounded-xl border border-border bg-secondary/50 px-4 py-3.5 text-xs leading-relaxed sm:text-sm"
        >
          Check your email at <strong>{verificationEmail}</strong> for a verification link, then
          sign in. If you already have an account, you can sign in or reset your password.
        </p>
        {error ? (
          <p role="alert" className="text-xs text-destructive sm:text-sm">
            {error}
          </p>
        ) : null}
        {resent ? (
          <p role="status" className="text-xs text-muted-foreground sm:text-sm">
            If your account needs verification, a new link is on its way.
          </p>
        ) : null}
        <Button
          className="h-11 w-full rounded-xl"
          disabled={pending || resent}
          onClick={async () => {
            setPending(true);
            setError(null);
            try {
              await sendVerificationEmail(verificationEmail, verificationCallback());
              setResent(true);
            } catch {
              setError("We couldn’t request a new link. Try again in a moment.");
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Requesting link…" : "Resend verification email"}
        </Button>
        <Link
          href={getAuthLink("/signin", safeReturnTo)}
          className="block text-center text-xs underline underline-offset-4 sm:text-sm"
        >
          Back to sign in
        </Link>
        <Link
          href="/forgot-password"
          className="block text-center text-xs text-muted-foreground underline underline-offset-4"
        >
          Reset your password
        </Link>
      </div>
    );
  }

  return (
    <form className="space-y-3.5" onSubmit={handleSubmit} noValidate={false}>
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-2.5 text-xs leading-relaxed text-foreground sm:text-sm"
        >
          {error}
        </div>
      ) : null}

      {isSignUp ? (
        <label className="block text-xs font-medium text-foreground">
          Name
          <input
            className={`${inputClassName} mt-1.5`}
            name="name"
            type="text"
            autoComplete="name"
            placeholder="Your name"
            minLength={2}
            required
            disabled={pending}
          />
        </label>
      ) : null}

      <label className="block text-xs font-medium text-foreground">
        Email
        <input
          className={`${inputClassName} mt-1.5`}
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
          disabled={pending}
        />
      </label>

      <div>
        <label className="block text-xs font-medium text-foreground">
          Password
          <input
            className={`${inputClassName} mt-1.5`}
            name="password"
            type="password"
            autoComplete={isSignUp ? "new-password" : "current-password"}
            placeholder="At least 8 characters"
            minLength={8}
            maxLength={128}
            required
            disabled={pending}
          />
        </label>
        {!isSignUp ? (
          <div className="mt-1.5 text-right">
            <Link
              href="/forgot-password"
              className="text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              Forgot password?
            </Link>
          </div>
        ) : null}
      </div>

      <Button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="h-11 w-full rounded-xl text-sm font-medium tracking-tight"
      >
        {pending ? <LoaderCircle className="animate-spin" size={16} aria-hidden="true" /> : null}
        {pending
          ? isSignUp
            ? "Creating account…"
            : "Signing in…"
          : isSignUp
            ? "Create account"
            : "Sign in"}
        {!pending ? <ArrowRight size={15} aria-hidden="true" /> : null}
      </Button>

      <p className="pt-1 text-center text-xs text-muted-foreground">
        {isSignUp ? "Already have an account?" : "New to MandatePay?"}{" "}
        <Link
          href={getAuthLink(alternatePath, safeReturnTo)}
          className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          {alternateLabel}
        </Link>
      </p>
    </form>
  );
}
