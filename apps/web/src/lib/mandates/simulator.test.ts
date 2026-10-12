import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIMULATOR_PRESETS,
  applyPreset,
  createDebouncedLatest,
  dollarsToMinor,
  formToSimulationRequest,
  initialSimulatorForm,
  minorToSliderDollars,
  readSimulationResult,
  simulateMandate,
  sliderMaxDollars,
} from "./simulator";
import type { CanonicalMandate } from "./types";

const rules: CanonicalMandate = {
  title: "Demo headphones",
  productIntent: "noise-cancelling headphones",
  currency: "USD",
  timezone: "UTC",
  allowedBrands: ["Sony", "Bose"],
  blockedBrands: [],
  allowedCategories: ["Headphones"],
  blockedCategories: [],
  allowedConditions: ["NEW"],
  autoSpendLimit: 15_000,
  transactionLimit: 18_000,
  quantityLimit: 1,
  allowedMerchants: [],
  blockedMerchants: [],
  newMerchantRequiresApproval: false,
};

const explanation = {
  decision: "REQUIRE_APPROVAL",
  headline: "Needs your approval — The total is above your automatic spending limit",
  summary: "Every hard rule passed.",
  approvalCanOverride: true,
  checks: [
    {
      rule: "automatic_limit",
      label: "Automatic limit",
      status: "approval",
      limit: "$150.00",
      actual: "$169.00",
      message: "The total is above your automatic spending limit.",
    },
  ],
};

describe("simulator money conversion", () => {
  it("converts slider dollars to integer cents without float drift", () => {
    expect(dollarsToMinor(139)).toBe(13_900);
    expect(dollarsToMinor(0.1 + 0.2)).toBe(30);
    expect(dollarsToMinor(1_000_000)).toBe(100_000_000);
    expect(() => dollarsToMinor(Number.NaN)).toThrow();
    expect(() => dollarsToMinor(-1)).toThrow();
    expect(minorToSliderDollars(16_999)).toBe(169);
    expect(minorToSliderDollars(-5)).toBe(0);
  });

  it("sizes the slider above the hard limit and the $220 story", () => {
    expect(sliderMaxDollars({ transactionLimit: 18_000 })).toBe(270);
    expect(sliderMaxDollars({ transactionLimit: 5_000 })).toBe(250);
    expect(sliderMaxDollars({ transactionLimit: 1_000_000_000 })).toBe(1_000_000);
  });

  it("prefills from the mandate rules at the automatic limit", () => {
    expect(initialSimulatorForm(rules)).toEqual({
      price: "150.00",
      quantity: "1",
      condition: "NEW",
      brand: "Sony",
      category: "Headphones",
      merchant: "Mandate Demo Store",
      treatAsNewStore: false,
    });
    expect(
      initialSimulatorForm({ ...rules, allowedMerchants: ["Northwind Audio"], autoSpendLimit: 5 })
        .price,
    ).toBe("1.00");
  });

  it("builds strict API requests from typed values", () => {
    const form = { ...initialSimulatorForm(rules), price: "169.5", treatAsNewStore: true };
    expect(formToSimulationRequest(form)).toEqual({
      ok: true,
      request: {
        price: 16_950,
        quantity: 1,
        condition: "NEW",
        brand: "Sony",
        category: "Headphones",
        merchant: "Mandate Demo Store",
        asNewMerchant: true,
      },
    });
    const blank = formToSimulationRequest({ ...form, brand: " ", category: "" });
    expect(blank.ok && "brand" in blank.request).toBe(false);
  });

  it.each([
    ["1.999", "price"],
    ["-1", "price"],
    ["abc", "price"],
    ["0", "price"],
    ["1000000.01", "price"],
  ])("rejects the price %s", (price) => {
    const result = formToSimulationRequest({ ...initialSimulatorForm(rules), price });
    expect(result.ok).toBe(false);
  });

  it("rejects bad quantities and a missing store", () => {
    const base = initialSimulatorForm(rules);
    expect(formToSimulationRequest({ ...base, quantity: "0" }).ok).toBe(false);
    expect(formToSimulationRequest({ ...base, quantity: "1.5" }).ok).toBe(false);
    expect(formToSimulationRequest({ ...base, quantity: "101" }).ok).toBe(false);
    expect(formToSimulationRequest({ ...base, merchant: "  " })).toEqual({
      ok: false,
      error: "Enter a store name.",
    });
  });

  it("offers the four demo stories as presets", () => {
    expect(SIMULATOR_PRESETS.map((preset) => preset.label)).toEqual([
      "$139 Sony",
      "$169 Sony",
      "$220 bundle",
      "Refurbished Bose",
    ]);
    const bose = applyPreset(
      { ...initialSimulatorForm(rules), quantity: "3" },
      SIMULATOR_PRESETS[3]!,
    );
    expect(bose).toMatchObject({
      price: "120.00",
      condition: "REFURBISHED",
      brand: "Bose",
      quantity: "1",
    });
    const requests = SIMULATOR_PRESETS.map((preset) =>
      formToSimulationRequest(applyPreset(initialSimulatorForm(rules), preset)),
    );
    expect(requests.map((result) => (result.ok ? result.request.price : null))).toEqual([
      13_900, 16_900, 22_000, 12_000,
    ]);
  });
});

describe("simulator response reader", () => {
  const valid = {
    simulated: true,
    decision: "REQUIRE_APPROVAL",
    reasonCodes: ["AUTO_SPEND_THRESHOLD_EXCEEDED"],
    explanation,
    mandate: { id: "m", version: 2, status: "ACTIVE" },
    facts: {
      subtotal: 16_900,
      total: 16_900,
      currency: "USD",
      isNewMerchant: false,
      newMerchantSource: "history",
    },
  };

  it("reads a valid simulation", () => {
    expect(readSimulationResult(valid)).toMatchObject({
      decision: "REQUIRE_APPROVAL",
      total: 16_900,
      explanation: { headline: explanation.headline },
    });
  });

  it("drops an explanation that disagrees with the verdict", () => {
    expect(readSimulationResult({ ...valid, decision: "ALLOW" }).explanation).toBeNull();
  });

  it.each([
    { ...valid, simulated: false },
    { ...valid, decision: "MAYBE" },
    { ...valid, reasonCodes: [1] },
    { ...valid, facts: { ...valid.facts, total: 1.5 } },
    null,
  ])("rejects a malformed response", (value) => {
    expect(() => readSimulationResult(value)).toThrow();
  });
});

describe("simulateMandate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to the same-origin BFF and reads the verdict", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        simulated: true,
        decision: "ALLOW",
        reasonCodes: [],
        explanation: null,
        facts: { total: 13_900, isNewMerchant: false, newMerchantSource: "history" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await simulateMandate("mandate/1", {
      price: 13_900,
      quantity: 1,
      condition: "NEW",
      merchant: "Mandate Demo Store",
    });
    expect(result.decision).toBe("ALLOW");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mandates/mandate%2F1/simulate");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(String(init.body))).toMatchObject({ price: 13_900 });
  });

  it("explains a rate limit and surfaces server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Too many" }, { status: 429 })),
    );
    await expect(
      simulateMandate("m", { price: 1, quantity: 1, condition: "NEW", merchant: "S" }),
    ).rejects.toMatchObject({ status: 429, message: expect.stringContaining("Pause briefly") });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Mandate not found." }, { status: 404 })),
    );
    await expect(
      simulateMandate("m", { price: 1, quantity: 1, condition: "NEW", merchant: "S" }),
    ).rejects.toMatchObject({ status: 404, message: "Mandate not found." });
  });
});

describe("createDebouncedLatest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("never debounces below 250 ms and only sends the last value", async () => {
    const run = vi.fn(async (input: number) => input * 2);
    const onResult = vi.fn();
    const runner = createDebouncedLatest({ delayMs: 10, run, onResult, onError: vi.fn() });
    expect(runner.delayMs).toBe(250);
    runner.schedule(1);
    runner.schedule(2);
    await vi.advanceTimersByTimeAsync(249);
    expect(run).not.toHaveBeenCalled();
    runner.schedule(3);
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe(3);
    expect(onResult).toHaveBeenCalledWith(6, 3);
  });

  it("aborts the in-flight request so a stale response is ignored", async () => {
    const pending = [deferred<string>(), deferred<string>()];
    const signals: AbortSignal[] = [];
    const onResult = vi.fn();
    const onError = vi.fn();
    const runner = createDebouncedLatest<number, string>({
      delayMs: 300,
      run: (input, signal) => {
        signals.push(signal);
        return pending[input]!.promise;
      },
      onResult,
      onError,
    });
    runner.now(0);
    runner.now(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    pending[1]!.resolve("fresh");
    pending[0]!.resolve("stale");
    await vi.runAllTimersAsync();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("fresh", 1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("cancel drops the pending timer and aborts the request in flight", async () => {
    const signals: AbortSignal[] = [];
    const run = vi.fn((_input: number, signal: AbortSignal) => {
      signals.push(signal);
      return Promise.reject(new Error("aborted"));
    });
    const onError = vi.fn();
    const runner = createDebouncedLatest({ delayMs: 300, run, onResult: vi.fn(), onError });
    runner.now(1);
    runner.cancel();
    runner.schedule(2);
    runner.cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports an error from the latest request", async () => {
    const onError = vi.fn();
    const onStart = vi.fn();
    const runner = createDebouncedLatest({
      delayMs: 300,
      run: async () => {
        throw new Error("offline");
      },
      onStart,
      onResult: vi.fn(),
      onError,
    });
    runner.schedule(7);
    await vi.advanceTimersByTimeAsync(300);
    expect(onStart).toHaveBeenCalledWith(7);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "offline" }), 7);
  });
});
