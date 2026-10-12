import { randomUUID } from "node:crypto";
import type { PayPalClient, WebhookProcessingResult } from "@mandatepay/paypal";
import {
  ObservabilityRepository,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_PENDING_MAX_ATTEMPTS,
  type DatabaseClient,
} from "@mandatepay/database";
import type { WorkerRunCounts } from "@mandatepay/shared";
import { webhookProcessingOpen } from "./platform-controls.js";
import {
  PrismaWebhookInboxStore,
  createPayPalWebhookService,
  type VerifiedWebhookRecoveryCandidate,
  type WebhookRetryLimits,
} from "./webhooks.js";

/** Failure policy: processing errors such as PayPal being unreachable. */
export const WEBHOOK_RECOVERY_MAX_ATTEMPTS = WEBHOOK_MAX_ATTEMPTS;
export const WEBHOOK_RECOVERY_LEASE_MS = 5 * 60_000;
export const WEBHOOK_RECOVERY_BASE_DELAY_MS = 5_000;
export const WEBHOOK_RECOVERY_MAX_DELAY_MS = 15 * 60_000;
export const WEBHOOK_RECOVERY_BATCH_SIZE = 50;
/**
 * Pending policy: the event is verified but provider state or the payment
 * binding is not ready yet (for example a held capture). 15 minutes doubling
 * to a 6 hour cap over 24 attempts keeps retrying for roughly four days.
 */
export const WEBHOOK_PENDING_RECOVERY_MAX_ATTEMPTS = WEBHOOK_PENDING_MAX_ATTEMPTS;
export const WEBHOOK_PENDING_BASE_DELAY_MS = 15 * 60_000;
export const WEBHOOK_PENDING_MAX_DELAY_MS = 6 * 60 * 60_000;

export const WEBHOOK_RECOVERY_LIMITS: WebhookRetryLimits = {
  failed: WEBHOOK_RECOVERY_MAX_ATTEMPTS,
  pending: WEBHOOK_PENDING_RECOVERY_MAX_ATTEMPTS,
};

export interface WebhookRetrySchedule {
  readonly limits?: WebhookRetryLimits;
  readonly failedBaseDelayMs?: number;
  readonly failedMaxDelayMs?: number;
  readonly pendingBaseDelayMs?: number;
  readonly pendingMaxDelayMs?: number;
}

/**
 * Next attempt for a claimed row, or null when it reached its ceiling. A
 * pending outcome moves the row to the long schedule and its higher ceiling.
 */
export function webhookRetryAt(
  input: {
    readonly attempts: number;
    readonly outcome: "pending" | "failed";
    readonly awaitingProvider: boolean;
    readonly now: Date;
  },
  schedule: WebhookRetrySchedule = {},
): Date | null {
  const limits = schedule.limits ?? WEBHOOK_RECOVERY_LIMITS;
  const pending = input.outcome === "pending";
  const ceiling = pending || input.awaitingProvider ? limits.pending : limits.failed;
  if (input.attempts >= ceiling) return null;
  const base = pending
    ? (schedule.pendingBaseDelayMs ?? WEBHOOK_PENDING_BASE_DELAY_MS)
    : (schedule.failedBaseDelayMs ?? WEBHOOK_RECOVERY_BASE_DELAY_MS);
  const cap = pending
    ? (schedule.pendingMaxDelayMs ?? WEBHOOK_PENDING_MAX_DELAY_MS)
    : (schedule.failedMaxDelayMs ?? WEBHOOK_RECOVERY_MAX_DELAY_MS);
  const delay = Math.min(cap, base * 2 ** Math.max(0, input.attempts - 1));
  return new Date(input.now.getTime() + delay);
}

export interface WebhookRecoveryOptions {
  /** Ceiling for rows whose processing failed. */
  readonly maxAttempts?: number;
  /** Ceiling for rows whose last outcome was pending provider state. */
  readonly pendingMaxAttempts?: number;
  readonly leaseMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly pendingBaseDelayMs?: number;
  readonly pendingMaxDelayMs?: number;
  readonly batchSize?: number;
  readonly now?: Date;
  readonly replay?: (
    candidate: VerifiedWebhookRecoveryCandidate,
  ) => Promise<WebhookProcessingResult>;
}

export interface WebhookRecoveryRunResult {
  readonly scanned: number;
  readonly claimed: number;
  readonly processed: number;
  readonly ignored: number;
  readonly pending: number;
  readonly exhausted: number;
}

export class PayPalWebhookRecoveryWorker {
  private readonly store: PrismaWebhookInboxStore;
  private readonly service: ReturnType<typeof createPayPalWebhookService>;

  constructor(
    private readonly database: DatabaseClient,
    paypal: PayPalClient,
    private readonly options: WebhookRecoveryOptions = {},
  ) {
    this.store = new PrismaWebhookInboxStore(database);
    this.service = createPayPalWebhookService(database, paypal);
  }

  async runOnce(now = this.options.now ?? new Date()): Promise<WebhookRecoveryRunResult> {
    const runId = randomUUID();
    const heartbeats = new ObservabilityRepository(this.database);
    const empty: WorkerRunCounts = {
      scanned: 0,
      claimed: 0,
      processed: 0,
      ignored: 0,
      pending: 0,
      exhausted: 0,
    };
    await heartbeats.beginWorkerRun({ runId, at: now });
    try {
      return await this.recover(now, runId, heartbeats, empty);
    } catch {
      try {
        await heartbeats.finishWorkerRun({
          runId,
          at: new Date(),
          outcome: "FAILED",
          counts: empty,
        });
      } catch {
        // The recovery failure is reported without a second error or any payload.
      }
      throw new Error("Webhook recovery failed.");
    }
  }

  private schedule(limits: WebhookRetryLimits): WebhookRetrySchedule {
    return {
      limits,
      ...(this.options.baseDelayMs === undefined
        ? {}
        : { failedBaseDelayMs: this.options.baseDelayMs }),
      ...(this.options.maxDelayMs === undefined
        ? {}
        : { failedMaxDelayMs: this.options.maxDelayMs }),
      ...(this.options.pendingBaseDelayMs === undefined
        ? {}
        : { pendingBaseDelayMs: this.options.pendingBaseDelayMs }),
      ...(this.options.pendingMaxDelayMs === undefined
        ? {}
        : { pendingMaxDelayMs: this.options.pendingMaxDelayMs }),
    };
  }

  private async recover(
    now: Date,
    runId: string,
    heartbeats: ObservabilityRepository,
    empty: WorkerRunCounts,
  ): Promise<WebhookRecoveryRunResult> {
    // Maintenance does not reach this worker. Only an explicit stored false stops it.
    if (!(await webhookProcessingOpen(this.database))) {
      await heartbeats.finishWorkerRun({ runId, at: now, outcome: "SKIPPED", counts: empty });
      return empty;
    }
    const limits: WebhookRetryLimits = {
      failed: this.options.maxAttempts ?? WEBHOOK_RECOVERY_MAX_ATTEMPTS,
      pending: this.options.pendingMaxAttempts ?? WEBHOOK_PENDING_RECOVERY_MAX_ATTEMPTS,
    };
    const schedule = this.schedule(limits);
    const leaseMs = this.options.leaseMs ?? WEBHOOK_RECOVERY_LEASE_MS;
    const batchSize = this.options.batchSize ?? WEBHOOK_RECOVERY_BATCH_SIZE;
    const candidates = await this.store.listRecoveryCandidates(now, limits, leaseMs, batchSize);
    const result = {
      scanned: candidates.length,
      claimed: 0,
      processed: 0,
      ignored: 0,
      pending: 0,
      exhausted: 0,
    };

    for (const candidate of candidates) {
      const claimed = await this.store.claimVerifiedForReplay(candidate.id, now, limits, leaseMs);
      if (!claimed) continue;
      result.claimed += 1;
      const replay =
        this.options.replay ??
        ((input: VerifiedWebhookRecoveryCandidate) =>
          this.service.replayVerified({ inboxId: input.id, event: input.payload }));
      let outcome: "pending" | "failed";
      try {
        const replayed = await replay(claimed);
        if (replayed === "processed") {
          await this.store.markProcessed(claimed.id);
          result.processed += 1;
          continue;
        }
        if (replayed === "ignored") {
          await this.store.markIgnored(claimed.id, "Verified webhook replay was ignored.");
          result.ignored += 1;
          continue;
        }
        outcome = "pending";
      } catch {
        outcome = "failed";
      }
      result.pending += 1;
      const next = webhookRetryAt(
        {
          attempts: claimed.attempts,
          outcome,
          awaitingProvider: claimed.awaitingProvider,
          now,
        },
        schedule,
      );
      const reason =
        outcome === "pending"
          ? "Verified webhook reconciliation is pending."
          : "Verified webhook recovery failed.";
      await this.store.scheduleRetry(
        claimed.id,
        next,
        next ? reason : `${reason} Retry limit reached.`,
        outcome === "pending" ? { awaitingProvider: true } : {},
      );
      if (!next) result.exhausted += 1;
    }
    await heartbeats.finishWorkerRun({
      runId,
      at: new Date(),
      outcome: "SUCCEEDED",
      counts: result,
    });
    return result;
  }
}
