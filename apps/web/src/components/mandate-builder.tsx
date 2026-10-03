"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, CircleAlert, LoaderCircle, ShieldCheck } from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import {
  createMandate,
  createMandateRequestKey,
  MandateApiError,
  parseMandate,
  transitionMandate,
} from "@/lib/mandates/client";
import {
  canonicalToForm,
  formToCanonical,
  MandateForm,
  EMPTY_MANDATE_FORM,
} from "@/components/mandate-form";
import type { MandateFormState } from "@/lib/mandates/types";
import Link from "next/link";
import { WorkspaceSteps } from "@/components/workspace-ui";
import { formatUsdLabel, parseUsdDecimal } from "@/lib/mandates/money";
import { MandatePermissions } from "@/components/mandate-permissions";

type BuilderState = "prompt" | "parsing" | "review" | "clarification" | "saving" | "saved";

function StatusMessage({ error, children }: { error?: boolean; children: React.ReactNode }) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-sm leading-relaxed",
        error
          ? "border-destructive/20 bg-destructive/8 text-foreground"
          : "border-border bg-secondary text-muted-foreground",
      )}
    >
      {error ? <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" /> : null}
      <span>{children}</span>
    </div>
  );
}

export function MandateBuilder() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [form, setForm] = useState<MandateFormState>(EMPTY_MANDATE_FORM);
  const [state, setState] = useState<BuilderState>("prompt");
  const [clarification, setClarification] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ id: string; version: number } | null>(null);
  const [creationKey, setCreationKey] = useState(() => createMandateRequestKey());
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);

  const isBusy = state === "parsing" || state === "saving";
  const describing = state === "prompt" || state === "parsing" || state === "clarification";

  useEffect(() => {
    if (!describing || (!clarification && !error)) return;
    feedbackRef.current?.focus({ preventScroll: true });
    feedbackRef.current?.scrollIntoView({ behavior: "instant", block: "nearest" });
  }, [clarification, error, describing]);

  useEffect(() => {
    if (state !== "review") return;
    reviewHeadingRef.current?.focus({ preventScroll: true });
    reviewHeadingRef.current?.scrollIntoView({ behavior: "instant", block: "nearest" });
  }, [state]);

  async function handleParse() {
    if (isBusy || !prompt.trim()) {
      setError("Describe what this mandate should cover first.");
      return;
    }

    setState("parsing");
    setAuthorized(false);
    setError(null);
    setClarification(null);
    setCreationKey(createMandateRequestKey());
    try {
      const result = await parseMandate(prompt.trim());
      if (result.status === "needs_clarification") {
        setClarification(result.clarification);
        setState("clarification");
        return;
      }

      const nextForm = canonicalToForm(result.mandate);
      formToCanonical(nextForm);
      setForm(nextForm);
      setEditing(false);
      setState("review");
    } catch (cause) {
      setState("prompt");
      setError(
        cause instanceof MandateApiError
          ? cause.status === 401
            ? "Your session has expired. Sign in again, then retry your request."
            : cause.status === 429
              ? "You’ve tried several times in a short period. Wait a minute, then try again."
              : cause.status >= 500
                ? "We couldn’t read your request because the service is temporarily unavailable. Try again shortly."
                : cause.status === 400
                  ? "We couldn’t understand part of your request. Check the product and maximum total budget in USD, then try again."
                  : cause.message
          : cause instanceof TypeError
            ? "We couldn’t connect. Check your internet connection and try again."
            : "We couldn’t prepare your mandate. Please try again in a moment.",
      );
    }
  }

  function validateForm() {
    try {
      setError(null);
      return formToCanonical(form);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review the mandate fields and try again.");
      return null;
    }
  }

  async function handleSave() {
    if (isBusy || !authorized) {
      if (!authorized) setError("Confirm that these are the exact permissions you want to save.");
      return;
    }

    const canonical = validateForm();
    if (!canonical) return;

    setState("saving");
    try {
      const saved = await createMandate(prompt.trim(), canonical, creationKey);
      setDraft({ id: saved.id, version: saved.version });
      setState("saved");
      setError(null);
    } catch (cause) {
      setState("review");
      setError(cause instanceof Error ? cause.message : "The draft could not be saved.");
    }
  }

  async function handleActivate() {
    if (isBusy || !draft) return;
    setState("saving");
    setError(null);
    try {
      const activated = await transitionMandate(draft.id, "activate", draft.version);
      router.push(`/mandates/${activated.id}`);
    } catch (cause) {
      setState("saved");
      setError(
        cause instanceof MandateApiError && cause.status === 409
          ? "This draft changed on the server. Refresh the draft before activating it."
          : cause instanceof Error
            ? cause.message
            : "Activation failed. You can retry without creating another draft.",
      );
    }
  }

  if (draft)
    return (
      <div className="space-y-6">
        <WorkspaceSteps steps={["Describe", "Review", "Activate"]} current={2} />
        <section className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-6 sm:p-8">
          <ShieldCheck size={25} className="text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-5 font-editorial text-3xl">Draft saved.</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Activate this mandate when you’re ready to use these permissions for shopping. Saving a
            draft does not authorize purchases.
          </p>
          <dl className="mt-6 grid gap-4 border-y border-border py-5 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Mandate</dt>
              <dd className="mt-1 text-sm font-medium">{form.title}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Spending permission</dt>
              <dd className="mt-1 text-sm font-medium">
                Automatic {formatUsdLabel(parseUsdDecimal(form.autoSpendLimit))} · Maximum{" "}
                {formatUsdLabel(parseUsdDecimal(form.transactionLimit))}
              </dd>
            </div>
          </dl>
          {error ? (
            <div className="mt-5">
              <StatusMessage error>{error}</StatusMessage>
            </div>
          ) : null}
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void handleActivate()}
              disabled={isBusy}
              className={buttonVariants()}
            >
              {isBusy ? (
                <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
              ) : (
                <ShieldCheck size={15} aria-hidden="true" />
              )}
              {isBusy ? "Activating…" : "Activate mandate"}
            </button>
            <Link
              href={`/mandates/${encodeURIComponent(draft.id)}`}
              className={buttonVariants({ variant: "outline" })}
            >
              View saved draft
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </section>
      </div>
    );

  if (describing) {
    return (
      <div className="space-y-7">
        <WorkspaceSteps steps={["Describe", "Review", "Activate"]} current={0} />
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-7">
            <label
              htmlFor="mandate-prompt"
              className="block text-lg font-medium tracking-[-0.02em]"
            >
              What should your agent be allowed to buy?
            </label>
            <p
              id="mandate-prompt-help"
              className="mt-3 max-w-[620px] text-sm leading-relaxed text-muted-foreground"
            >
              Describe the product, budget, brands, conditions, and when the agent should come back
              to you. Include your maximum total budget in USD, including shipping and tax.
            </p>
            <textarea
              id="mandate-prompt"
              ref={promptRef}
              aria-describedby={`mandate-prompt-help${clarification || error ? " mandate-prompt-feedback" : ""}`}
              aria-invalid={clarification ? true : undefined}
              maxLength={12_000}
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              disabled={isBusy}
              placeholder="Find Sony or Bose noise-cancelling headphones under $180. Buy new only. Automatically spend up to $150 and ask me above that."
              className="mt-5 min-h-44 w-full resize-y rounded-lg border border-border bg-background px-4 py-4 text-sm leading-7 transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
            />
            {clarification || error ? (
              <div
                id="mandate-prompt-feedback"
                ref={feedbackRef}
                role="alert"
                tabIndex={-1}
                aria-labelledby="mandate-prompt-feedback-title"
                className="mt-4 scroll-mt-28 rounded-xl border border-destructive/20 bg-secondary p-4 text-sm leading-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <div className="flex items-start gap-3">
                  <CircleAlert size={18} className="mt-1 shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <h2 id="mandate-prompt-feedback-title" className="font-medium">
                      {clarification
                        ? "Add a little more detail to continue"
                        : "We couldn’t review your request"}
                    </h2>
                    <p className="mt-1">{clarification ?? error}</p>
                    <p className="mt-2 text-muted-foreground">
                      {clarification
                        ? "Update your request above with this detail, then select Review mandate again."
                        : "Your request is still here. You can try again without retyping it."}
                    </p>
                  </div>
                </div>
                {clarification ? (
                  <button
                    type="button"
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-3")}
                    onClick={() => promptRef.current?.focus()}
                  >
                    Edit my request
                  </button>
                ) : null}
              </div>
            ) : null}
            {state === "parsing" ? (
              <p role="status" className="mt-4 text-sm leading-6 text-muted-foreground">
                Reading your request… This may take a few moments.
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
              <span className="text-xs text-muted-foreground">
                You’ll review the exact rules before activation.
              </span>
              <button
                type="button"
                onClick={() => void handleParse()}
                disabled={isBusy || !prompt.trim()}
                className={cn(buttonVariants({ size: "lg" }), "min-w-36")}
              >
                {state === "parsing" ? (
                  <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                ) : (
                  <ArrowRight size={16} aria-hidden="true" />
                )}
                {state === "parsing" ? "Reading request…" : error ? "Try again" : "Review mandate"}
              </button>
            </div>
          </div>
          <aside className="px-1 py-2 text-sm">
            <h2 className="font-medium">A clear request includes</h2>
            <dl className="mt-5 space-y-5 text-sm">
              <div>
                <dt className="font-medium">What to buy</dt>
                <dd className="mt-1 leading-6 text-muted-foreground">
                  Product, brands, and condition.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Your maximum</dt>
                <dd className="mt-1 leading-6 text-muted-foreground">
                  A hard limit for each purchase.
                </dd>
              </div>
              <div>
                <dt className="font-medium">When to ask you</dt>
                <dd className="mt-1 leading-6 text-muted-foreground">
                  An automatic limit below your maximum, or approval for every purchase.
                </dd>
              </div>
            </dl>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <WorkspaceSteps steps={["Describe", "Review", "Activate"]} current={1} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            ref={reviewHeadingRef}
            tabIndex={-1}
            className="scroll-mt-28 text-xl font-medium leading-7 tracking-[-0.02em] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            These are the permissions your agent will receive.
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {!editing ? (
            <button
              type="button"
              onClick={() => {
                setEditing(true);
                setAuthorized(false);
              }}
              disabled={isBusy}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Edit permissions
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setState("prompt");
              setError(null);
            }}
            disabled={isBusy}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
          >
            <ArrowLeft size={15} aria-hidden="true" /> Edit request
          </button>
        </div>
      </div>

      <details className="rounded-lg border border-border bg-secondary/50 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium">Original instruction</summary>
        <blockquote className="mt-3 text-sm leading-6">“{prompt}”</blockquote>
      </details>

      {editing ? (
        <MandateForm
          value={form}
          onChange={(next) => {
            setForm(next);
            setAuthorized(false);
            setCreationKey(createMandateRequestKey());
          }}
          disabled={isBusy}
        />
      ) : (
        <MandatePermissions mandate={formToCanonical(form)} />
      )}

      {error ? <StatusMessage error>{error}</StatusMessage> : null}

      {editing ? (
        <div className="flex justify-end border-t border-border pt-4">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => {
              if (validateForm()) setEditing(false);
            }}
            className={buttonVariants({ variant: "outline" })}
          >
            Done editing
            <Check size={15} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border py-4">
          <label className="flex max-w-xl items-start gap-3 text-sm leading-6 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-ring">
            <input
              type="checkbox"
              checked={authorized}
              onChange={(event) => setAuthorized(event.currentTarget.checked)}
              disabled={isBusy}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span>I have reviewed these exact permissions and authorize saving this draft.</span>
          </label>

          <div className="flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={isBusy || !authorized}
              className={cn(buttonVariants({ size: "lg" }))}
            >
              {state === "saving" ? (
                <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
              ) : (
                <Check size={16} aria-hidden="true" />
              )}
              {state === "saving" ? "Saving draft…" : "Save draft"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
