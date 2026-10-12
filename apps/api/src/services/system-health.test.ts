import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSystemHealthSchema, AdminWorkerHealthSchema } from "@mandatepay/shared";

const NOW = new Date("2026-10-12T12:00:00.000Z");

type Row = {
  runId: string;
  startedAt: Date;
  heartbeatAt: Date;
  completedAt: Date | null;
  outcome: "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
  errorCode: string | null;
  scanned: number;
  claimed: number;
  processed: number;
  ignored: number;
  pending: number;
  exhausted: number;
};

const heartbeats = new Map<string, Row | null>();
let databaseDown = false;

vi.mock("@mandatepay/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mandatepay/database")>();
  class FakeObservabilityRepository {
    async pingDatabase() {
      if (databaseDown) throw new Error("down");
      return 4;
    }
    async latestWorker(_now: Date, worker = "paypal-webhook-recovery") {
      return { row: heartbeats.get(worker) ?? null, staleBefore: new Date(0) };
    }
    async webhookOperations() {
      return {
        failed: 0,
        retrying: 0,
        backlog: 0,
        staleLeases: 0,
        exhausted: 0,
        lastProcessedAt: null,
      };
    }
    async latestAgentRun() {
      return null;
    }
    async lastSuccessfulReconcile() {
      return null;
    }
    async platformControlRows() {
      return [];
    }
  }
  return { ...original, ObservabilityRepository: FakeObservabilityRepository };
});

const { readSystemHealth, workerHealth } = await import("./system-health.js");

function row(minutesAgo: number, outcome: Row["outcome"] = "SUCCEEDED"): Row {
  const at = new Date(NOW.getTime() - minutesAgo * 60_000);
  return {
    runId: "6f0d3c1e-8a1b-4c2d-9e3f-0a1b2c3d4e5f",
    startedAt: at,
    heartbeatAt: at,
    completedAt: outcome === "RUNNING" ? null : at,
    outcome,
    errorCode: outcome === "FAILED" ? "WORKER_FAILED" : null,
    scanned: 3,
    claimed: 2,
    processed: 2,
    ignored: 1,
    pending: 0,
    exhausted: 0,
  };
}

let unboundVaultPayments = 0;
const countPayments = vi.fn<(args: unknown) => Promise<number>>(async () => unboundVaultPayments);

async function read() {
  return readSystemHealth({
    database: { payment: { count: countPayments } } as never,
    environment: "test",
    paypalConfigured: false,
    channel3Configured: false,
    now: NOW,
  });
}

function componentOf(result: Awaited<ReturnType<typeof read>>, id: string) {
  return result.health.components.find((item) => item.id === id);
}

beforeEach(() => {
  heartbeats.clear();
  databaseDown = false;
  unboundVaultPayments = 0;
  countPayments.mockClear();
});

describe("system health workers", () => {
  it("reports the payment reconcile worker as its own subsystem", async () => {
    heartbeats.set("paypal-webhook-recovery", row(2));
    heartbeats.set("paypal-payment-reconcile", row(3));
    const result = await read();
    expect(result.health.components.map((item) => item.id)).toEqual([
      "api",
      "database",
      "worker",
      "reconcileWorker",
      "webhooks",
      "paypal",
      "channel3",
      "demoCatalog",
      "agent",
    ]);
    expect(componentOf(result, "reconcileWorker")).toMatchObject({
      status: "ready",
      configured: true,
      summary: "The last payment reconciliation run succeeded.",
      lastSuccessAt: "2026-10-12T11:57:00.000Z",
    });
    expect(result.workers.workers.map((worker) => worker.worker)).toEqual([
      "paypal-webhook-recovery",
      "paypal-payment-reconcile",
    ]);
    expect(result.workers.workers[1]).toMatchObject({ status: "ready", counts: { scanned: 3 } });
    expect(AdminSystemHealthSchema.safeParse(result.health).success).toBe(true);
    expect(AdminWorkerHealthSchema.safeParse(result.workers).success).toBe(true);
  });

  it("treats a missing reconcile heartbeat as unknown, not healthy", async () => {
    heartbeats.set("paypal-webhook-recovery", row(1));
    const result = await read();
    expect(componentOf(result, "worker")?.status).toBe("ready");
    expect(componentOf(result, "reconcileWorker")).toMatchObject({
      status: "unknown",
      summary: expect.stringContaining("No payment reconciliation heartbeat"),
    });
    expect(result.workers.workers[1]).toMatchObject({
      worker: "paypal-payment-reconcile",
      status: "unknown",
      runId: null,
      heartbeatAt: null,
    });
    expect(result.health.overall).toBe("unknown");
    expect(AdminWorkerHealthSchema.safeParse(result.workers).success).toBe(true);
  });

  it("marks a reconcile heartbeat older than 15 minutes as degraded", async () => {
    heartbeats.set("paypal-webhook-recovery", row(1));
    heartbeats.set("paypal-payment-reconcile", row(16));
    const result = await read();
    expect(componentOf(result, "reconcileWorker")).toMatchObject({
      status: "degraded",
      summary: "The last payment reconciliation heartbeat is older than 15 minutes.",
    });
    expect(result.health.overall).toBe("degraded");
  });

  it("surfaces held autonomous payments with an unknown PayPal outcome as reconcile backlog", async () => {
    heartbeats.set("paypal-webhook-recovery", row(1));
    heartbeats.set("paypal-payment-reconcile", row(1));
    expect(componentOf(await read(), "reconcileWorker")).toMatchObject({
      status: "ready",
      backlog: 0,
    });
    unboundVaultPayments = 2;
    const result = await read();
    expect(componentOf(result, "reconcileWorker")).toMatchObject({
      status: "degraded",
      backlog: 2,
      summary: expect.stringContaining("2 autonomous payment(s) with an unknown PayPal outcome"),
    });
    expect(result.health.overall).toBe("degraded");
    expect(countPayments).toHaveBeenLastCalledWith({
      where: {
        status: "CAPTURE_PENDING",
        paymentSource: "VAULT",
        paypalOrderId: null,
        isSample: false,
        updatedAt: { lte: new Date(NOW.getTime() - 30 * 60_000) },
      },
    });
    expect(AdminSystemHealthSchema.safeParse(result.health).success).toBe(true);
  });

  it("degrades on a failed reconcile run and keeps only the safe error code", async () => {
    heartbeats.set("paypal-payment-reconcile", row(1, "FAILED"));
    const result = await read();
    expect(componentOf(result, "reconcileWorker")?.status).toBe("degraded");
    expect(componentOf(result, "reconcileWorker")?.lastSuccessAt).toBeNull();
    expect(result.workers.workers[1]?.errorCode).toBe("WORKER_FAILED");
  });

  it("reports both workers as unknown when the database is unavailable", async () => {
    databaseDown = true;
    const result = await read();
    expect(componentOf(result, "worker")?.status).toBe("unknown");
    expect(componentOf(result, "reconcileWorker")?.status).toBe("unknown");
    expect(result.workers.workers.every((worker) => worker.status === "unknown")).toBe(true);
    expect(result.health.overall).toBe("unavailable");
  });

  it("keeps the webhook worker copy for the webhook subsystem", () => {
    const { component, snapshot } = workerHealth({
      worker: "paypal-webhook-recovery",
      id: "worker",
      row: null,
      enabled: true,
      now: NOW,
    });
    expect(component.summary).toBe(
      "No webhook worker heartbeat has been recorded. Liveness is unknown.",
    );
    expect(component.enabled).toBe(true);
    expect(snapshot).toMatchObject({ worker: "paypal-webhook-recovery", status: "unknown" });
  });
});
