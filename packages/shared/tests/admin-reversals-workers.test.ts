import { describe, expect, it } from "vitest";
import {
  ADMIN_WORKER_NAMES,
  AdminSystemHealthSchema,
  AdminWorkerHealthSchema,
  SYSTEM_COMPONENT_IDS,
  workerLiveness,
} from "../src/admin-observability.js";
import { CAPTURED_PAYMENT_STATUSES, paymentReconciliation } from "../src/admin-operations.js";
import { ADMIN_METRIC_DEFINITIONS } from "../src/admin-metrics.js";

const now = new Date("2026-10-12T12:00:00.000Z");

function snapshot(worker: string) {
  return {
    worker,
    status: "ready",
    runId: "6f0d3c1e-8a1b-4c2d-9e3f-0a1b2c3d4e5f",
    startedAt: "2026-10-12T11:58:00.000Z",
    heartbeatAt: "2026-10-12T11:58:00.000Z",
    completedAt: "2026-10-12T11:58:00.000Z",
    outcome: "SUCCEEDED",
    errorCode: null,
    counts: { scanned: 1, claimed: 1, processed: 1, ignored: 0, pending: 0, exhausted: 0 },
  };
}

describe("payment reconciliation worker health", () => {
  it("applies the same unknown/degraded rules with its own copy", () => {
    const worker = "paypal-payment-reconcile" as const;
    expect(workerLiveness({ heartbeatAt: null, outcome: null, now, worker })).toEqual({
      status: "unknown",
      summary: "No payment reconciliation heartbeat has been recorded. Liveness is unknown.",
    });
    expect(
      workerLiveness({
        heartbeatAt: new Date(now.getTime() - 15 * 60_000 - 1),
        outcome: "SUCCEEDED",
        now,
        worker,
      }),
    ).toEqual({
      status: "degraded",
      summary: "The last payment reconciliation heartbeat is older than 15 minutes.",
    });
    expect(
      workerLiveness({
        heartbeatAt: new Date(now.getTime() - 15 * 60_000),
        outcome: "SUCCEEDED",
        now,
        worker,
      }).status,
    ).toBe("ready");
    expect(workerLiveness({ heartbeatAt: now, outcome: "FAILED", now, worker }).summary).toBe(
      "The last payment reconciliation run failed.",
    );
    // The default stays the webhook worker so existing callers keep their copy.
    expect(workerLiveness({ heartbeatAt: null, outcome: null, now }).summary).toContain(
      "webhook worker",
    );
  });

  it("accepts both scheduled workers and the new subsystem in admin contracts", () => {
    expect(ADMIN_WORKER_NAMES).toEqual(["paypal-webhook-recovery", "paypal-payment-reconcile"]);
    expect(
      AdminWorkerHealthSchema.safeParse({
        observedAt: now.toISOString(),
        staleAfterSeconds: 900,
        workers: [snapshot("paypal-webhook-recovery"), snapshot("paypal-payment-reconcile")],
      }).success,
    ).toBe(true);
    expect(
      AdminWorkerHealthSchema.safeParse({
        observedAt: now.toISOString(),
        staleAfterSeconds: 900,
        workers: [snapshot("some-other-worker")],
      }).success,
    ).toBe(false);
    expect(SYSTEM_COMPONENT_IDS).toContain("reconcileWorker");
    expect(
      AdminSystemHealthSchema.safeParse({
        observedAt: now.toISOString(),
        environment: "test",
        build: { commitSha: null, version: null },
        overall: "unknown",
        components: SYSTEM_COMPONENT_IDS.map((id) => ({
          id,
          status: "unknown",
          configured: null,
          enabled: null,
          summary: "Not checked.",
          latencyMs: null,
          lastSuccessAt: null,
          backlog: null,
          failed: null,
          retrying: null,
        })),
      }).success,
    ).toBe(true);
  });
});

describe("PayPal reversals in admin money metrics", () => {
  it("counts a reversed payment as captured and settled", () => {
    expect(CAPTURED_PAYMENT_STATUSES).toContain("REVERSED");
    expect(
      paymentReconciliation({
        status: "REVERSED",
        paypalOrderId: "ORDER-1",
        paypalCaptureId: "CAPTURE-1",
        capturedAt: now.toISOString(),
      }),
    ).toBe("SETTLED");
  });

  it("documents that reversals reduce net, not gross, captured volume", () => {
    expect(ADMIN_METRIC_DEFINITIONS.capturedGrossMinor).toContain("reversals do not reduce");
    expect(ADMIN_METRIC_DEFINITIONS.netCapturedMinor).toContain("PayPal-reversed");
    expect(ADMIN_METRIC_DEFINITIONS.capturedPayments).toContain("reversed");
  });
});
