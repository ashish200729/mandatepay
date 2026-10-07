-- CreateEnum
CREATE TYPE "WorkerRunOutcome" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AgentRunOutcome" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentErrorClass" AS ENUM ('NONE', 'TIMEOUT', 'PROVIDER_UNAVAILABLE', 'INVALID_RESPONSE', 'TOOL_FAILURE', 'RATE_LIMITED', 'CANCELLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WebhookDeliveryOutcome" AS ENUM ('REJECTED', 'ACCEPTED', 'DUPLICATE');

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "worker" VARCHAR(64) NOT NULL,
    "runId" VARCHAR(36) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "outcome" "WorkerRunOutcome" NOT NULL,
    "errorCode" VARCHAR(64),
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "claimed" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "ignored" INTEGER NOT NULL DEFAULT 0,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "exhausted" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRunMetric" (
    "id" TEXT NOT NULL,
    "requestId" VARCHAR(64) NOT NULL,
    "userId" TEXT NOT NULL,
    "modelId" VARCHAR(64) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "outcome" "AgentRunOutcome" NOT NULL,
    "errorClass" "AgentErrorClass" NOT NULL,
    "proposalId" VARCHAR(255),
    "refundDraftId" VARCHAR(255),

    CONSTRAINT "AgentRunMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentToolMetric" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "outcome" "AgentRunOutcome" NOT NULL,
    "errorClass" "AgentErrorClass" NOT NULL,

    CONSTRAINT "AgentToolMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDeliveryMetric" (
    "id" TEXT NOT NULL,
    "requestId" VARCHAR(64) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" VARCHAR(32) NOT NULL,
    "eventType" VARCHAR(64),
    "outcome" "WebhookDeliveryOutcome" NOT NULL,
    "inboxId" TEXT,

    CONSTRAINT "WebhookDeliveryMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkerHeartbeat_runId_key" ON "WorkerHeartbeat"("runId");
CREATE INDEX "WorkerHeartbeat_worker_heartbeatAt_id_idx" ON "WorkerHeartbeat"("worker", "heartbeatAt", "id");
CREATE INDEX "AgentRunMetric_startedAt_id_idx" ON "AgentRunMetric"("startedAt", "id");
CREATE INDEX "AgentRunMetric_userId_startedAt_id_idx" ON "AgentRunMetric"("userId", "startedAt", "id");
CREATE INDEX "AgentRunMetric_outcome_errorClass_startedAt_id_idx" ON "AgentRunMetric"("outcome", "errorClass", "startedAt", "id");
CREATE INDEX "AgentRunMetric_modelId_startedAt_id_idx" ON "AgentRunMetric"("modelId", "startedAt", "id");
CREATE INDEX "AgentToolMetric_runId_startedAt_id_idx" ON "AgentToolMetric"("runId", "startedAt", "id");
CREATE INDEX "AgentToolMetric_name_outcome_startedAt_idx" ON "AgentToolMetric"("name", "outcome", "startedAt");
CREATE INDEX "WebhookDeliveryMetric_receivedAt_id_idx" ON "WebhookDeliveryMetric"("receivedAt", "id");
CREATE INDEX "WebhookDeliveryMetric_outcome_receivedAt_id_idx" ON "WebhookDeliveryMetric"("outcome", "receivedAt", "id");

ALTER TABLE "AgentRunMetric"
  ADD CONSTRAINT "AgentRunMetric_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentToolMetric"
  ADD CONSTRAINT "AgentToolMetric_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "AgentRunMetric"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkerHeartbeat"
  ADD CONSTRAINT "WorkerHeartbeat_worker_check" CHECK ("worker" = 'paypal-webhook-recovery'),
  ADD CONSTRAINT "WorkerHeartbeat_error_check" CHECK ("errorCode" IS NULL OR "errorCode" = 'WORKER_FAILED'),
  ADD CONSTRAINT "WorkerHeartbeat_counts_check" CHECK (
    "scanned" >= 0 AND "claimed" >= 0 AND "processed" >= 0 AND "ignored" >= 0 AND "pending" >= 0 AND "exhausted" >= 0
    AND "scanned" <= 100000 AND "claimed" <= 100000 AND "processed" <= 100000
    AND "ignored" <= 100000 AND "pending" <= 100000 AND "exhausted" <= 100000
  );

ALTER TABLE "AgentRunMetric"
  ADD CONSTRAINT "AgentRunMetric_request_check" CHECK ("requestId" ~ '^[A-Za-z0-9_-]{8,64}$'),
  ADD CONSTRAINT "AgentRunMetric_model_check" CHECK ("modelId" ~ '^[A-Za-z0-9._:-]{1,64}$'),
  ADD CONSTRAINT "AgentRunMetric_duration_check" CHECK ("durationMs" IS NULL OR ("durationMs" >= 0 AND "durationMs" <= 600000)),
  ADD CONSTRAINT "AgentRunMetric_proposal_check" CHECK ("proposalId" IS NULL OR "proposalId" ~ '^[A-Za-z0-9_-]{1,255}$'),
  ADD CONSTRAINT "AgentRunMetric_refund_check" CHECK ("refundDraftId" IS NULL OR "refundDraftId" ~ '^[A-Za-z0-9_-]{1,255}$');

ALTER TABLE "AgentToolMetric"
  ADD CONSTRAINT "AgentToolMetric_name_check" CHECK (
    "name" IN (
      'get_active_mandates',
      'search_products',
      'get_product_details',
      'compare_products',
      'create_purchase_proposal',
      'find_transaction',
      'prepare_refund_request'
    )
  ),
  ADD CONSTRAINT "AgentToolMetric_duration_check" CHECK ("durationMs" IS NULL OR ("durationMs" >= 0 AND "durationMs" <= 600000));

ALTER TABLE "WebhookDeliveryMetric"
  ADD CONSTRAINT "WebhookDeliveryMetric_provider_check" CHECK ("provider" = 'paypal'),
  ADD CONSTRAINT "WebhookDeliveryMetric_request_check" CHECK ("requestId" ~ '^[A-Za-z0-9_-]{8,64}$'),
  ADD CONSTRAINT "WebhookDeliveryMetric_event_check" CHECK ("eventType" IS NULL OR "eventType" ~ '^[A-Z0-9._]{1,64}$');
