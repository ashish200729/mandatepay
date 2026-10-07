"use client";
import { useRef, useState } from "react";
import { ArrowRight, Eye, EyeOff, AlertCircle } from "lucide-react";
import { adminFieldClass } from "@/lib/control-styles";
import { useRouter } from "next/navigation";
import { Button } from "@mandatepay/ui/components/button";

export function SignInForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const errorElement = useRef<HTMLParagraphElement>(null);
  const lock = useRef(false);
  function showError(message: string) {
    setError(message);
    requestAnimationFrame(() => errorElement.current?.focus());
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    const form = event.currentTarget;
    const fields = new FormData(form);
    const password = fields.get("password");
    (form.elements.namedItem("password") as HTMLInputElement).value = "";
    setVisible(false);
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
        showError(body?.error?.message ?? "Unable to sign in. Try again shortly.");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      showError("Administration is temporarily unavailable. Try again shortly.");
    } finally {
      setPending(false);
      lock.current = false;
    }
  }
  return (
    <form onSubmit={submit} className="space-y-5" aria-busy={pending}>
      <div>
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={320}
          disabled={pending}
          aria-describedby="admin-email-help"
          className={`${adminFieldClass} mt-2 h-12`}
        />
        <p id="admin-email-help" className="mt-2 text-xs leading-5 text-muted-foreground">
          Use your verified administrator email.
        </p>
      </div>
      <div>
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <div className="relative mt-2">
          <input
            id="password"
            name="password"
            type={visible ? "text" : "password"}
            autoComplete="current-password"
            required
            maxLength={128}
            disabled={pending}
            aria-describedby={error ? "sign-in-error" : undefined}
            className={`${adminFieldClass} h-12 pr-12`}
          />
          <button
            type="button"
            aria-label={visible ? "Hide password" : "Show password"}
            aria-controls="password"
            aria-pressed={visible}
            disabled={pending}
            onClick={() => setVisible(!visible)}
            className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 motion-reduce:transition-none"
          >
            {visible ? (
              <EyeOff size={18} aria-hidden="true" />
            ) : (
              <Eye size={18} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      {error && (
        <p
          id="sign-in-error"
          ref={errorElement}
          tabIndex={-1}
          role="alert"
          className="flex gap-2.5 rounded-lg border border-admin-danger-foreground/20 bg-admin-danger p-3 text-sm leading-6 text-admin-danger-foreground"
        >
          <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
      <Button
        type="submit"
        disabled={pending}
        className="h-12 w-full justify-between rounded-lg px-4"
      >
        {pending ? "Signing in…" : "Sign in to admin"}
        <ArrowRight size={17} aria-hidden="true" />
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
