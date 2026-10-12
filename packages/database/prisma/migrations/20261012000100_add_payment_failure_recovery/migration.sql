-- Additive only: new enum values, nullable/defaulted columns and an index.
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REVERSED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'PAYMENT_REVERSED';

ALTER TABLE "Payment"
  ADD COLUMN "providerStatusReason" VARCHAR(64),
  ADD COLUMN "payerActionUrl" VARCHAR(2048);

CREATE INDEX "Payment_status_updatedAt_idx" ON "Payment" ("status", "updatedAt");

ALTER TABLE "Refund"
  ADD COLUMN "providerInitiated" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "WebhookInbox"
  ADD COLUMN "awaitingProvider" BOOLEAN NOT NULL DEFAULT false;
