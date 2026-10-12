"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FlaskConical, LoaderCircle } from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { DecisionExplanation } from "@/components/decision-explanation";
import { workspaceField } from "@/components/workspace-ui";
import { formatUsdLabel, formatUsdMinor, parseUsdDecimal } from "@/lib/mandates/money";
import {
  SIMULATOR_PRESETS,
  applyPreset,
  createDebouncedLatest,
  dollarsToMinor,
  formToSimulationRequest,
  initialSimulatorForm,
  minorToSliderDollars,
  simulateMandate,
  sliderMaxDollars,
  type SimulationRequest,
  type SimulationResult,
  type SimulatorForm,
  type SimulatorPreset,
} from "@/lib/mandates/simulator";
import { PRODUCT_CONDITIONS, type MandateDetail } from "@/lib/mandates/types";

const CONDITION_LABELS = { NEW: "New", USED: "Used", REFURBISHED: "Refurbished" } as const;

const VERDICT_ANNOUNCEMENTS = {
  ALLOW: "AgentGuard would allow this purchase.",
  REQUIRE_APPROVAL: "AgentGuard would ask for your approval.",
  BLOCK: "AgentGuard would block this purchase.",
} as const;

function presetMatches(form: SimulatorForm, preset: SimulatorPreset) {
  return (
    form.quantity.trim() === "1" &&
    form.price.trim() === preset.values.price &&
    form.condition === preset.values.condition &&
    form.brand.trim() === preset.values.brand &&
    form.category.trim() === preset.values.category &&
    form.merchant.trim() === preset.values.merchant
  );
}

function sliderDollars(price: string) {
  try {
    return minorToSliderDollars(parseUsdDecimal(price));
  } catch {
    return 0;
  }
}

/**
 * "What would AgentGuard do?" — a read-only, live evaluation of a hypothetical
 * purchase against this mandate's active version. The server runs the real
 * deterministic engine inside a read-only transaction: no proposal, hold,
 * approval, audit row or PayPal call is ever created from here.
 */
export function PolicySimulator({ mandate }: { mandate: MandateDetail }) {
  const baseId = useId();
  const [open, setOpen] = useState(false);
  const headingId = `${baseId}-heading`;
  const panelId = `${baseId}-panel`;
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <h2 id={headingId} className="flex items-center gap-2 text-base font-medium">
            <FlaskConical size={17} aria-hidden="true" />
            Try AgentGuard
          </h2>
          <p className="mt-1 max-w-[560px] text-sm leading-relaxed text-muted-foreground">
            See what AgentGuard would decide for a hypothetical purchase under this mandate, using
            your current spending and autonomy settings.
          </p>
          <p className="mt-3 inline-flex rounded-full border border-sand-border bg-sand px-3 py-1 text-xs font-medium">
            Simulation only — nothing is purchased
          </p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className={cn(buttonVariants({ variant: open ? "ghost" : "outline" }))}
        >
          {open ? "Hide simulator" : "Try a purchase"}
        </button>
      </div>
      {/* Mounted only when open, so viewing a mandate never runs a simulation. */}
      {open ? <SimulatorWorkspace id={panelId} mandate={mandate} /> : null}
    </section>
  );
}

function SimulatorWorkspace({ id, mandate }: { id: string; mandate: MandateDetail }) {
  const baseId = useId();
  const [form, setForm] = useState<SimulatorForm>(() => initialSimulatorForm(mandate.rules));
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const runner = useRef<ReturnType<
    typeof createDebouncedLatest<SimulationRequest, SimulationResult>
  > | null>(null);

  const validation = useMemo(() => formToSimulationRequest(form), [form]);
  const maxDollars = sliderMaxDollars(mandate.rules);

  useEffect(() => {
    const current = createDebouncedLatest<SimulationRequest, SimulationResult>({
      delayMs: 300,
      run: (request, signal) => simulateMandate(mandate.id, request, signal),
      onStart: () => setChecking(true),
      onResult: (output) => {
        setResult(output);
        setRequestError(null);
        setChecking(false);
      },
      onError: (cause) => {
        setRequestError(
          cause instanceof Error ? cause.message : "The simulator could not check that purchase.",
        );
        setChecking(false);
      },
    });
    runner.current = current;
    return () => {
      current.cancel();
      runner.current = null;
    };
  }, [mandate.id]);

  // A new mandate version or status (for example after Pause) is re-evaluated too.
  useEffect(() => {
    if (validation.ok) runner.current?.schedule(validation.request);
    else runner.current?.cancel();
  }, [validation, mandate.version, mandate.status]);

  const update = <Key extends keyof SimulatorForm>(key: Key, value: SimulatorForm[Key]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const ids = {
    price: `${baseId}-price`,
    slider: `${baseId}-slider`,
    quantity: `${baseId}-quantity`,
    condition: `${baseId}-condition`,
    brand: `${baseId}-brand`,
    category: `${baseId}-category`,
    merchant: `${baseId}-merchant`,
    error: `${baseId}-error`,
  };
  const stale = !validation.ok || checking;
  const announcement = !validation.ok
    ? ""
    : requestError
      ? `Simulation failed. ${requestError}`
      : result && !checking
        ? `${VERDICT_ANNOUNCEMENTS[result.decision]} ${result.explanation?.headline ?? ""}`.trim()
        : "";

  return (
    <div id={id} className="mt-5 border-t border-border pt-5">
      <div role="group" aria-label="Demo scenarios">
        <p className="text-xs text-muted-foreground">Try a demo story</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {SIMULATOR_PRESETS.map((preset) => {
            const active = presetMatches(form, preset);
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={active}
                title={preset.description}
                onClick={() => setForm((current) => applyPreset(current, preset))}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none",
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background hover:bg-secondary",
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-6 grid min-w-0 gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => event.preventDefault()}
          aria-describedby={!validation.ok ? ids.error : undefined}
        >
          <div>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <label htmlFor={ids.price} className="text-sm font-medium">
                Price per item (USD)
              </label>
              <span className="text-xs text-muted-foreground">
                Automatic up to {formatUsdLabel(mandate.rules.autoSpendLimit)} · max{" "}
                {formatUsdLabel(mandate.rules.transactionLimit)}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <label htmlFor={ids.slider} className="sr-only">
                Price slider in whole dollars
              </label>
              <input
                id={ids.slider}
                type="range"
                min={1}
                max={maxDollars}
                step={1}
                value={Math.min(maxDollars, Math.max(1, sliderDollars(form.price)))}
                aria-valuetext={formatUsdLabel(dollarsToMinor(sliderDollars(form.price)))}
                onChange={(event) =>
                  update("price", formatUsdMinor(dollarsToMinor(Number(event.currentTarget.value))))
                }
                className="h-11 min-w-0 flex-1 accent-primary"
              />
              <div className="relative w-28 shrink-0">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
                >
                  $
                </span>
                <input
                  id={ids.price}
                  inputMode="decimal"
                  autoComplete="off"
                  value={form.price}
                  onChange={(event) => update("price", event.currentTarget.value)}
                  aria-invalid={!validation.ok && /price|amount|USD|\$/u.test(validation.error)}
                  className={cn(workspaceField, "pl-6 tabular-nums")}
                />
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor={ids.condition} className="text-sm font-medium">
                Condition
              </label>
              <select
                id={ids.condition}
                value={form.condition}
                onChange={(event) =>
                  update("condition", event.currentTarget.value as SimulatorForm["condition"])
                }
                className={cn(workspaceField, "mt-2")}
              >
                {PRODUCT_CONDITIONS.map((condition) => (
                  <option key={condition} value={condition}>
                    {CONDITION_LABELS[condition]}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <label htmlFor={ids.quantity} className="text-sm font-medium">
                Quantity
              </label>
              <input
                id={ids.quantity}
                inputMode="numeric"
                autoComplete="off"
                value={form.quantity}
                onChange={(event) => update("quantity", event.currentTarget.value)}
                aria-invalid={
                  !validation.ok && /quantity|whole number|items/iu.test(validation.error)
                }
                className={cn(workspaceField, "mt-2 tabular-nums")}
              />
            </div>
            <div className="min-w-0">
              <label htmlFor={ids.brand} className="text-sm font-medium">
                Brand
              </label>
              <input
                id={ids.brand}
                autoComplete="off"
                maxLength={120}
                value={form.brand}
                onChange={(event) => update("brand", event.currentTarget.value)}
                className={cn(workspaceField, "mt-2")}
              />
            </div>
            <div className="min-w-0">
              <label htmlFor={ids.category} className="text-sm font-medium">
                Category
              </label>
              <input
                id={ids.category}
                autoComplete="off"
                maxLength={120}
                value={form.category}
                onChange={(event) => update("category", event.currentTarget.value)}
                className={cn(workspaceField, "mt-2")}
              />
            </div>
            <div className="min-w-0 sm:col-span-2">
              <label htmlFor={ids.merchant} className="text-sm font-medium">
                Store
              </label>
              <input
                id={ids.merchant}
                autoComplete="off"
                maxLength={200}
                value={form.merchant}
                onChange={(event) => update("merchant", event.currentTarget.value)}
                aria-invalid={!validation.ok && /store/iu.test(validation.error)}
                className={cn(workspaceField, "mt-2")}
              />
            </div>
          </div>

          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border px-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
            <input
              type="checkbox"
              checked={form.treatAsNewStore}
              onChange={(event) => update("treatAsNewStore", event.currentTarget.checked)}
              className="size-4 accent-primary"
            />
            Treat as a new store
            <span className="text-xs text-muted-foreground">
              (otherwise your purchase history decides)
            </span>
          </label>

          {!validation.ok ? (
            <p id={ids.error} className="text-sm text-destructive" role="alert">
              {validation.error}
            </p>
          ) : null}
        </form>

        <div className="min-w-0">
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
          <div
            className={cn(
              "min-w-0 rounded-xl border border-border bg-background p-4 transition-opacity motion-reduce:transition-none sm:p-5",
              stale && result ? "opacity-60" : null,
            )}
            aria-busy={checking}
          >
            <div className="flex min-h-6 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>What AgentGuard would decide</span>
              {checking ? (
                <span className="inline-flex items-center gap-1.5">
                  <LoaderCircle
                    size={13}
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  Checking…
                </span>
              ) : null}
            </div>
            {requestError ? <p className="mt-3 text-sm text-destructive">{requestError}</p> : null}
            {result ? (
              <>
                <DecisionExplanation
                  className="mt-3"
                  decision={{
                    decision: result.decision,
                    reasonCodes: result.reasonCodes,
                    explanation: result.explanation,
                  }}
                />
                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Simulated total</dt>
                    <dd className="mt-1 text-sm font-medium tabular-nums">
                      {formatUsdLabel(result.total)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Store</dt>
                    <dd className="mt-1 text-sm font-medium">
                      {result.isNewMerchant ? "New store" : "Known store"}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {result.newMerchantSource === "override"
                          ? "Set by the toggle"
                          : "From your purchase history"}
                      </span>
                    </dd>
                  </div>
                </dl>
              </>
            ) : !requestError ? (
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {validation.ok
                  ? "Checking this purchase against your mandate…"
                  : "Fix the highlighted field to see AgentGuard’s decision."}
              </p>
            ) : null}
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              A simulation creates no proposal, spending hold, approval or audit record, and never
              contacts PayPal. Real purchases are re-checked when they are proposed and again before
              payment.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
