import type { PrismaClient, Prisma } from "../generated/prisma/client.js";
import { WebhookProcessingStatus } from "../generated/prisma/enums.js";
import { getPrismaClient } from "../client.js";
import { DatabaseError } from "../errors.js";

export interface ReceiveWebhookInput {
  provider: string;
  providerEventId: string;
  eventType: string;
  signatureVerified: boolean;
  payload: Prisma.InputJsonValue;
}

export class WebhookInboxRepository {
  constructor(private readonly db: PrismaClient = getPrismaClient()) {}

  receive(input: ReceiveWebhookInput) {
    if (!input.provider.trim() || !input.providerEventId.trim() || !input.eventType.trim()) {
      throw new DatabaseError(
        "INVALID_DOMAIN_INPUT",
        "Provider, event ID, and event type are required.",
      );
    }

    return this.db.webhookInbox.upsert({
      where: {
        provider_providerEventId: {
          provider: input.provider,
          providerEventId: input.providerEventId,
        },
      },
      create: {
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        signatureVerified: input.signatureVerified,
        payload: input.payload,
        status: WebhookProcessingStatus.RECEIVED,
      },
      update: {
        signatureVerified: input.signatureVerified ? true : undefined,
      },
    });
  }

  find(provider: string, providerEventId: string) {
    return this.db.webhookInbox.findUnique({
      where: { provider_providerEventId: { provider, providerEventId } },
    });
  }

  markProcessing(id: string) {
    return this.db.webhookInbox.update({
      where: { id },
      data: {
        status: WebhookProcessingStatus.PROCESSING,
        attempts: { increment: 1 },
        lastError: null,
      },
    });
  }

  markProcessed(id: string) {
    return this.db.webhookInbox.update({
      where: { id },
      data: { status: WebhookProcessingStatus.PROCESSED, processedAt: new Date() },
    });
  }

  markFailed(id: string, error: string) {
    return this.db.webhookInbox.update({
      where: { id },
      data: { status: WebhookProcessingStatus.FAILED, lastError: error.slice(0, 10_000) },
    });
  }
}
