import { readDecisionExplanation } from "../approvals/reasons";
import type { DecisionExplanation } from "../approvals/types";
import { MandateApiError } from "./client";
import { parseQuantity, parseUsdDecimal } from "./money";
import { PRODUCT_CONDITIONS, type CanonicalMandate, type ProductCondition } from "./types";

/**
 * Client helpers for the read-only AgentGuard policy simulator. A simulation
 * never creates a proposal or moves money; the server evaluates the mandate's
 * active version with the real deterministic engine and returns its verdict.
 */

/** Matches the API: at most $1,000,000 per unit. */
export const SIMULATOR_MAX_MINOR = 100_000_000;
export const SIMULATOR_MAX_QUANTITY = 100;
/** Live evaluation never fires more often than this while the user is typing or dragging. */
export const SIMULATOR_MIN_DEBOUNCE_MS = 250;

export type SimulationRequest = {
  price: number;
  quantity: number;
  condition: ProductCondition;
  brand?: string;
  category?: string;
  merchant: string;
  asNewMerchant?: boolean;
};

export type SimulationResult = {
  simulated: true;
  decision: DecisionExplanation["decision"];
  reasonCodes: string[];
  explanation: DecisionExplanation | null;
  total: number;
  isNewMerchant: boolean;
  newMerchantSource: "history" | "override";
};

/** Editable form state; amounts stay strings until they are converted to cents. */
export type SimulatorForm = {
  price: string;
  quantity: string;
  condition: ProductCondition;
  brand: string;
  category: string;
  merchant: string;
  treatAsNewStore: boolean;
};

export type SimulatorPreset = {
  id: string;
  label: string;
  description: string;
  values: Pick<SimulatorForm, "price" | "condition" | "brand" | "category" | "merchant">;
};

const DEMO_STORE = "Mandate Demo Store";

/** The four Demo Catalog stories, shown as one-tap presets. */
export const SIMULATOR_PRESETS: readonly SimulatorPreset[] = Object.freeze([
  {
    id: "sony-139",
    label: "$139 Sony",
    description: "Sony WH-1000XM5, new, $139",
    values: {
      price: "139.00",
      condition: "NEW",
      brand: "Sony",
      category: "Headphones",
      merchant: DEMO_STORE,
    },
  },
  {
    id: "sony-169",
    label: "$169 Sony",
    description: "Sony WH-1000XM5, new, $169",
    values: {
      price: "169.00",
      condition: "NEW",
      brand: "Sony",
      category: "Headphones",
      merchant: DEMO_STORE,
    },
  },
  {
    id: "bundle-220",
    label: "$220 bundle",
    description: "Sony WH-1000XM5 + travel case bundle, new, $220",
    values: {
      price: "220.00",
      condition: "NEW",
      brand: "Sony",
      category: "Headphones",
      merchant: DEMO_STORE,
    },
  },
  {
    id: "bose-refurbished",
    label: "Refurbished Bose",
    description: "Bose QuietComfort, refurbished, $120",
    values: {
      price: "120.00",
      condition: "REFURBISHED",
      brand: "Bose",
      category: "Headphones",
      merchant: DEMO_STORE,
    },
  },
]);

/** Whole-dollar slider value to integer cents, without floating-point multiplication. */
export function dollarsToMinor(dollars: number) {
  if (!Number.isFinite(dollars) || dollars < 0) throw new Error("Enter a valid USD amount.");
  return parseUsdDecimal(dollars.toFixed(2));
}

/** Integer cents to the whole-dollar position of the slider (rounded down). */
export function minorToSliderDollars(minor: number) {
  if (!Number.isSafeInteger(minor) || minor < 0) return 0;
  return Math.floor(minor / 100);
}

/** Slider upper bound: comfortably above the mandate's hard limit and the $220 demo story. */
export function sliderMaxDollars(rules: Pick<CanonicalMandate, "transactionLimit">) {
  const limitDollars = Math.ceil(rules.transactionLimit / 100);
  const target = Math.max(250, Math.ceil(limitDollars * 1.5));
  return Math.min(SIMULATOR_MAX_MINOR / 100, Math.ceil(target / 10) * 10);
}

function centsToDecimal(minor: number) {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

/** Starting values from the mandate's own rules, priced at its automatic limit. */
export function initialSimulatorForm(rules: CanonicalMandate): SimulatorForm {
  const price = Math.max(100, Math.min(rules.autoSpendLimit, SIMULATOR_MAX_MINOR));
  return {
    price: centsToDecimal(price),
    quantity: "1",
    condition: rules.allowedConditions[0] ?? "NEW",
    brand: rules.allowedBrands[0] ?? "",
    category: rules.allowedCategories[0] ?? "",
    merchant: rules.allowedMerchants[0] ?? DEMO_STORE,
    treatAsNewStore: false,
  };
}

export function applyPreset(form: SimulatorForm, preset: SimulatorPreset): SimulatorForm {
  return { ...form, ...preset.values, quantity: "1" };
}

/** Converts the form to an API request, or explains which field needs attention. */
export function formToSimulationRequest(
  form: SimulatorForm,
): { ok: true; request: SimulationRequest } | { ok: false; error: string } {
  let price: number;
  let quantity: number;
  try {
    price = parseUsdDecimal(form.price);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "Enter a valid price." };
  }
  if (price < 1) return { ok: false, error: "Enter a price above $0.00." };
  if (price > SIMULATOR_MAX_MINOR) {
    return { ok: false, error: "Simulations are limited to $1,000,000 per item." };
  }
  try {
    quantity = parseQuantity(form.quantity);
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "Enter a whole-number quantity.",
    };
  }
  if (quantity > SIMULATOR_MAX_QUANTITY) {
    return { ok: false, error: `Simulations are limited to ${SIMULATOR_MAX_QUANTITY} items.` };
  }
  if (!PRODUCT_CONDITIONS.includes(form.condition)) {
    return { ok: false, error: "Choose a product condition." };
  }
  const merchant = form.merchant.trim();
  if (!merchant) return { ok: false, error: "Enter a store name." };
  const brand = form.brand.trim();
  const category = form.category.trim();
  return {
    ok: true,
    request: {
      price,
      quantity,
      condition: form.condition,
      ...(brand ? { brand: brand.slice(0, 120) } : {}),
      ...(category ? { category: category.slice(0, 120) } : {}),
      merchant: merchant.slice(0, 200),
      ...(form.treatAsNewStore ? { asNewMerchant: true } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a simulator response; anything malformed is rejected, never trusted. */
export function readSimulationResult(value: unknown): SimulationResult {
  if (
    !isRecord(value) ||
    value.simulated !== true ||
    (value.decision !== "ALLOW" &&
      value.decision !== "REQUIRE_APPROVAL" &&
      value.decision !== "BLOCK") ||
    !Array.isArray(value.reasonCodes) ||
    value.reasonCodes.some((code) => typeof code !== "string") ||
    !isRecord(value.facts)
  ) {
    throw new Error("The simulator returned an invalid response.");
  }
  const facts = value.facts;
  if (
    typeof facts.total !== "number" ||
    !Number.isSafeInteger(facts.total) ||
    facts.total < 0 ||
    typeof facts.isNewMerchant !== "boolean"
  ) {
    throw new Error("The simulator returned an invalid response.");
  }
  const explanation = readDecisionExplanation(value.explanation);
  return {
    simulated: true,
    decision: value.decision,
    reasonCodes: (value.reasonCodes as string[]).slice(0, 40),
    // A mismatched explanation is dropped rather than shown against another verdict.
    explanation: explanation?.decision === value.decision ? explanation : null,
    total: facts.total,
    isNewMerchant: facts.isNewMerchant,
    newMerchantSource: facts.newMerchantSource === "override" ? "override" : "history",
  };
}

export async function simulateMandate(
  mandateId: string,
  request: SimulationRequest,
  signal?: AbortSignal,
): Promise<SimulationResult> {
  const response = await fetch(`/api/mandates/${encodeURIComponent(mandateId)}/simulate`, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      response.status === 429
        ? "Too many checks in a minute. Pause briefly, then change a value to try again."
        : isRecord(payload) && typeof payload.error === "string"
          ? payload.error.slice(0, 240)
          : "The simulator could not check that purchase.";
    throw new MandateApiError(message, response.status);
  }
  return readSimulationResult(payload);
}

export interface DebouncedLatestOptions<Input, Output> {
  delayMs: number;
  run: (input: Input, signal: AbortSignal) => Promise<Output>;
  onStart?: (input: Input) => void;
  onResult: (output: Output, input: Input) => void;
  onError: (error: unknown, input: Input) => void;
}

/**
 * Debounces requests and keeps only the latest: a new request cancels the
 * pending timer and aborts the one in flight, so a slow, stale response can
 * never overwrite a newer verdict.
 */
export function createDebouncedLatest<Input, Output>(
  options: DebouncedLatestOptions<Input, Output>,
) {
  const delayMs = Math.max(SIMULATOR_MIN_DEBOUNCE_MS, options.delayMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let sequence = 0;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const fire = (input: Input) => {
    timer = null;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const id = ++sequence;
    options.onStart?.(input);
    options.run(input, current.signal).then(
      (output) => {
        if (id === sequence && !current.signal.aborted) options.onResult(output, input);
      },
      (error: unknown) => {
        if (id === sequence && !current.signal.aborted) options.onError(error, input);
      },
    );
  };

  return {
    delayMs,
    /** Schedules a request after the debounce delay, replacing any pending one. */
    schedule(input: Input) {
      clearTimer();
      timer = setTimeout(() => fire(input), delayMs);
    },
    /** Runs immediately (for example after choosing a preset). */
    now(input: Input) {
      clearTimer();
      fire(input);
    },
    /** Drops the pending request and aborts the one in flight. */
    cancel() {
      clearTimer();
      sequence += 1;
      controller?.abort();
      controller = null;
    },
  };
}
