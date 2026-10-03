"use client";

import { useState } from "react";
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
  const [draft, setDraft] = useState<{ id: string; version: number } | null>(null);
  const [creationKey, setCreationKey] = useState(() => createMandateRequestKey());

  const isBusy = state === "parsing" || state === "saving";

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

      setForm(canonicalToForm(result.mandate));
      setState("review");
    } catch (cause) {
      setState("prompt");
      setError(cause instanceof Error ? cause.message : "The mandate parser is unavailable.");
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

  if (state === "prompt" || state === "parsing" || state === "clarification") {
    return (
      <div className="space-y-7">
        <div className="rounded-2xl border border-border bg-card p-6 sm:p-8">
          <label
            htmlFor="mandate-prompt"
            className="block font-editorial text-3xl tracking-[-0.025em] sm:text-4xl"
          >
            What should your agent be allowed to buy?
          </label>
          <p className="mt-3 max-w-[620px] text-sm leading-relaxed text-muted-foreground">
            Describe the product, budget, brands, conditions, and when the agent should come back to
            you.
          </p>
          <textarea
            id="mandate-prompt"
            maxLength={12_000}
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            disabled={isBusy}
            placeholder="Find Sony or Bose noise-cancelling headphones under $180. Buy new only. Automatically spend up to $150 and ask me above that."
            className="mt-7 min-h-44 w-full resize-y rounded-2xl border border-border bg-background px-4 py-4 text-base leading-relaxed transition-colors placeholder:text-muted-foreground/70 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-4 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
          />
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
            <span className="text-xs text-muted-foreground">
              The prompt is retained as the original instruction for audit.
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
              {state === "parsing" ? "Reading request…" : "Review mandate"}
            </button>
          </div>
        </div>
        {clarification ? (
          <StatusMessage>
            <strong className="font-medium text-foreground">One detail is missing.</strong>{" "}
            {clarification}
          </StatusMessage>
        ) : null}
        {error ? <StatusMessage error>{error}</StatusMessage> : null}
      </div>
    );
  }

  const draftReady = state === "saved" && draft;
  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Review before saving
          </p>
          <h2 className="mt-2 font-editorial text-3xl tracking-[-0.025em] sm:text-4xl">
            These are the permissions your agent will receive.
          </h2>
        </div>
        <button
          type="button"
          onClick={() => {
            setState("prompt");
            setError(null);
          }}
          disabled={isBusy || Boolean(draft)}
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
        >
          <ArrowLeft size={15} aria-hidden="true" /> Edit request
        </button>
      </div>

      <section className="rounded-2xl border border-sand-border bg-sand p-5 sm:p-7">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <ShieldCheck size={16} aria-hidden="true" /> Original instruction
        </div>
        <blockquote className="mt-4 font-editorial text-2xl leading-tight tracking-[-0.02em]">
          “{prompt}”
        </blockquote>
      </section>

      <MandateForm
        value={form}
        onChange={(next) => {
          setForm(next);
          setAuthorized(false);
          setCreationKey(createMandateRequestKey());
        }}
        disabled={isBusy || Boolean(draft)}
      />

      {draftReady ? (
        <StatusMessage>
          Draft saved. The exact permission version is ready for activation.
        </StatusMessage>
      ) : null}
      {error ? <StatusMessage error>{error}</StatusMessage> : null}

      {!draft ? (
        <label className="flex items-start gap-3 rounded-2xl border border-border bg-card p-5 text-sm leading-relaxed has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-ring">
          <input
            type="checkbox"
            checked={authorized}
            onChange={(event) => setAuthorized(event.currentTarget.checked)}
            disabled={isBusy}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span>
            I have reviewed these exact permissions and authorize MandatePay to save this mandate as
            a draft.
          </span>
        </label>
      ) : null}

      <div className="flex flex-wrap justify-end gap-3">
        {!draft ? (
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
        ) : (
          <button
            type="button"
            onClick={() => void handleActivate()}
            disabled={isBusy}
            className={cn(buttonVariants({ size: "lg" }))}
          >
            {state === "saving" ? (
              <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <ShieldCheck size={16} aria-hidden="true" />
            )}
            {state === "saving" ? "Activating…" : "Activate mandate"}
          </button>
        )}
      </div>
      <p className="text-right text-xs text-muted-foreground">
        Activation is explicit. A draft cannot authorize a purchase.
      </p>
    </div>
  );
}
