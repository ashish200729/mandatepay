import type { PayPalClient, WebhookProcessingResult } from "@mandatepay/paypal";
import type { DatabaseClient } from "@mandatepay/database";
import {
  PrismaWebhookInboxStore,
  createPayPalWebhookService,
  type VerifiedWebhookRecoveryCandidate,
} from "./webhooks.js";

export const WEBHOOK_RECOVERY_MAX_ATTEMPTS = 5;
export const WEBHOOK_RECOVERY_LEASE_MS = 5 * 60_000;
export const WEBHOOK_RECOVERY_BASE_DELAY_MS = 5_000;
export const WEBHOOK_RECOVERY_MAX_DELAY_MS = 15 * 60_000;
export const WEBHOOK_RECOVERY_BATCH_SIZE = 50;

export interface WebhookRecoveryOptions {
  readonly maxAttempts?: number;
  readonly leaseMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
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
    database: DatabaseClient,
    paypal: PayPalClient,
    private readonly options: WebhookRecoveryOptions = {},
  ) {
    this.store = new PrismaWebhookInboxStore(database);
    this.service = createPayPalWebhookService(database, paypal);
  }

  async runOnce(now = this.options.now ?? new Date()): Promise<WebhookRecoveryRunResult> {
    const maxAttempts = this.options.maxAttempts ?? WEBHOOK_RECOVERY_MAX_ATTEMPTS;
    const leaseMs = this.options.leaseMs ?? WEBHOOK_RECOVERY_LEASE_MS;
    const batchSize = this.options.batchSize ?? WEBHOOK_RECOVERY_BATCH_SIZE;
    const baseDelayMs = this.options.baseDelayMs ?? WEBHOOK_RECOVERY_BASE_DELAY_MS;
    const maxDelayMs = this.options.maxDelayMs ?? WEBHOOK_RECOVERY_MAX_DELAY_MS;
    const candidates = await this.store.listRecoveryCandidates(
      now,
      maxAttempts,
      leaseMs,
      batchSize,
    );
    const result = {
      scanned: candidates.length,
      claimed: 0,
      processed: 0,
      ignored: 0,
      pending: 0,
      exhausted: 0,
    };

    for (const candidate of candidates) {
      const claimed = await this.store.claimVerifiedForReplay(
        candidate.id,
        now,
        maxAttempts,
        leaseMs,
      );
      if (!claimed) continue;
      result.claimed += 1;
      const replay =
        this.options.replay ??
        ((input: VerifiedWebhookRecoveryCandidate) =>
          this.service.replayVerified({ inboxId: input.id, event: input.payload }));
      try {
        const outcome = await replay(claimed);
        if (outcome === "processed") {
          await this.store.markProcessed(claimed.id);
          result.processed += 1;
        } else if (outcome === "ignored") {
          await this.store.markIgnored(claimed.id, "Verified webhook replay was ignored.");
          result.ignored += 1;
        } else {
          result.pending += 1;
          await this.retryOrExhaust(
            claimed,
            now,
            maxAttempts,
            baseDelayMs,
            maxDelayMs,
            "Verified webhook reconciliation is pending.",
          );
          if (claimed.attempts >= maxAttempts) result.exhausted += 1;
        }
      } catch {
        result.pending += 1;
        await this.retryOrExhaust(
          claimed,
          now,
          maxAttempts,
          baseDelayMs,
          maxDelayMs,
          "Verified webhook recovery failed.",
        );
        if (claimed.attempts >= maxAttempts) result.exhausted += 1;
      }
    }
    return result;
  }

  private retryOrExhaust(
    claimed: VerifiedWebhookRecoveryCandidate,
    now: Date,
    maxAttempts: number,
    baseDelayMs: number,
    maxDelayMs: number,
    reason: string,
  ) {
    if (claimed.attempts >= maxAttempts) {
      return this.store.scheduleRetry(claimed.id, null, `${reason} Retry limit reached.`);
    }
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, claimed.attempts - 1));
    return this.store.scheduleRetry(claimed.id, new Date(now.getTime() + delay), reason);
  }
}
