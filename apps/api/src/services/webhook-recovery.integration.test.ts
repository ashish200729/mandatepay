import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  WebhookProcessingStatus,
  type DatabaseClient,
} from "@mandatepay/database";
import type { PayPalClient } from "@mandatepay/paypal";
import { PayPalWebhookRecoveryWorker } from "./webhook-recovery.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) {
  throw new Error("Webhook recovery integration requires a dedicated TEST_DATABASE_URL.");
}

const now = new Date("2000-01-02T12:00:00Z");
const fakePayPal = {} as PayPalClient;

function event(id: string) {
  return { id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "capture-" + id } };
}

describe("verified PayPal webhook recovery worker", () => {
  let database: DatabaseClient;

  beforeAll(() => {
    database = createPrismaClient(databaseUrl);
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it("retries pending verified events with bounded backoff and then processes", async () => {
    const id = "RECOVERY-BACKOFF-" + randomUUID();
    const row = await database.webhookInbox.create({
      data: {
        provider: "paypal",
        providerEventId: id,
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        signatureVerified: true,
        payload: event(id),
        status: WebhookProcessingStatus.FAILED,
        attempts: 0,
        nextAttemptAt: new Date(now.getTime() - 1_000),
      },
    });
    let calls = 0;
    const worker = new PayPalWebhookRecoveryWorker(database, fakePayPal, {
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      batchSize: 1,
      replay: async () => {
        calls += 1;
        return calls === 1 ? "pending" : "processed";
      },
    });
    const first = await worker.runOnce(now);
    expect(first.pending).toBe(1);
    const scheduled = await database.webhookInbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(scheduled.status).toBe(WebhookProcessingStatus.FAILED);
    expect(scheduled.attempts).toBe(1);
    expect(scheduled.nextAttemptAt?.getTime()).toBe(now.getTime() + 100);
    await worker.runOnce(new Date(now.getTime() + 50));
    expect(calls).toBe(1);
    const second = await worker.runOnce(new Date(now.getTime() + 101));
    expect(second.processed).toBe(1);
    expect((await database.webhookInbox.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      WebhookProcessingStatus.PROCESSED,
    );
  });

  it("serializes concurrent leases and never claims an unsigned row", async () => {
    const id = "RECOVERY-CONCURRENT-" + randomUUID();
    const unsignedId = "RECOVERY-UNSIGNED-" + randomUUID();
    await database.webhookInbox.createMany({
      data: [
        {
          provider: "paypal",
          providerEventId: id,
          eventType: "PAYMENT.CAPTURE.COMPLETED",
          signatureVerified: true,
          payload: event(id),
          status: WebhookProcessingStatus.FAILED,
          attempts: 0,
          nextAttemptAt: new Date(now.getTime() - 1_000),
        },
        {
          provider: "paypal",
          providerEventId: unsignedId,
          eventType: "PAYMENT.CAPTURE.COMPLETED",
          signatureVerified: false,
          payload: event(unsignedId),
          status: WebhookProcessingStatus.FAILED,
          attempts: 0,
          nextAttemptAt: new Date(now.getTime() - 1_000),
        },
      ],
    });
    let calls = 0;
    const replay = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "processed" as const;
    };
    const first = new PayPalWebhookRecoveryWorker(database, fakePayPal, { replay, batchSize: 1 });
    const second = new PayPalWebhookRecoveryWorker(database, fakePayPal, { replay, batchSize: 1 });
    await Promise.all([first.runOnce(now), second.runOnce(now)]);
    expect(calls).toBe(1);
    expect(
      (
        await database.webhookInbox.findFirstOrThrow({
          where: { provider: "paypal", providerEventId: unsignedId },
        })
      ).status,
    ).toBe(WebhookProcessingStatus.FAILED);
  });

  it("stops retrying after the configured attempt limit", async () => {
    const id = "RECOVERY-EXHAUSTED-" + randomUUID();
    const row = await database.webhookInbox.create({
      data: {
        provider: "paypal",
        providerEventId: id,
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        signatureVerified: true,
        payload: event(id),
        status: WebhookProcessingStatus.FAILED,
        attempts: 4,
        nextAttemptAt: new Date(now.getTime() - 1_000),
      },
    });
    let calls = 0;
    const worker = new PayPalWebhookRecoveryWorker(database, fakePayPal, {
      maxAttempts: 5,
      batchSize: 1,
      replay: async () => {
        calls += 1;
        return "pending";
      },
    });
    await worker.runOnce(now);
    expect(calls).toBe(1);
    const exhausted = await database.webhookInbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(exhausted.attempts).toBe(5);
    expect(exhausted.nextAttemptAt).toBeNull();
    await worker.runOnce(new Date(now.getTime() + 86_400_000));
    expect(calls).toBe(1);
  });
});
