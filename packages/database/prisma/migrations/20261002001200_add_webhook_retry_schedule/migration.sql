ALTER TABLE "WebhookInbox"
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

CREATE INDEX "WebhookInbox_retry_schedule_idx"
  ON "WebhookInbox" ("provider", "signatureVerified", "status", "nextAttemptAt", "updatedAt");
