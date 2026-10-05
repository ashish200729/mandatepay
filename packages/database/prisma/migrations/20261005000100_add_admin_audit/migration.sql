-- CreateEnum
CREATE TYPE "AdminAuditAction" AS ENUM ('ADMIN_LOGIN_SUCCEEDED', 'ADMIN_LOGIN_FAILED', 'ADMIN_REAUTH_SUCCEEDED', 'ADMIN_REAUTH_FAILED', 'ADMIN_LOGOUT_SUCCEEDED', 'ADMIN_USER_DISABLED', 'ADMIN_USER_ENABLED', 'ADMIN_SESSIONS_REVOKED', 'ADMIN_AUTONOMY_DISABLED', 'ADMIN_NOTE_ADDED', 'ADMIN_MANDATE_PAUSED', 'ADMIN_MANDATE_REVOKED', 'ADMIN_PAYMENT_RECONCILE_REQUESTED', 'ADMIN_REFUND_REQUESTED', 'ADMIN_WEBHOOK_RETRY_REQUESTED', 'ADMIN_WEBHOOK_RECONCILE_REQUESTED', 'ADMIN_FEATURE_FLAG_CHANGED', 'ADMIN_MAINTENANCE_MODE_CHANGED');

-- CreateEnum
CREATE TYPE "AdminAuditTargetType" AS ENUM ('ADMIN_AUTH', 'ADMIN_SESSION', 'USER', 'MANDATE', 'PROPOSAL', 'APPROVAL', 'PAYMENT', 'REFUND', 'WEBHOOK', 'PLATFORM_SETTING', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AdminAuditResult" AS ENUM ('PENDING', 'SUCCESS', 'FAILURE');

-- CreateEnum
CREATE TYPE "AdminAuditErrorCode" AS ENUM ('ADMIN_SIGN_IN_REJECTED', 'ADMIN_UNAUTHORIZED', 'ADMIN_FORBIDDEN', 'ADMIN_REAUTH_REQUIRED', 'ADMIN_INVALID_REQUEST', 'ADMIN_RATE_LIMITED', 'ADMIN_UNAVAILABLE', 'INVALID_STATE', 'CONFLICT', 'TARGET_NOT_FOUND', 'PROVIDER_PENDING', 'PROVIDER_UNAVAILABLE', 'DOMAIN_REJECTED');

-- CreateEnum
CREATE TYPE "AdminActionRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "AdminAuditEvent" (
    "id" TEXT NOT NULL,
    "actorAdminId" TEXT,
    "actorUserId" TEXT,
    "role" "AdminRole",
    "action" "AdminAuditAction" NOT NULL,
    "targetType" "AdminAuditTargetType" NOT NULL,
    "targetId" VARCHAR(255) NOT NULL,
    "reason" VARCHAR(255) NOT NULL,
    "requestId" VARCHAR(36) NOT NULL,
    "correlationId" VARCHAR(36) NOT NULL,
    "actionId" TEXT,
    "beforeSummaryJson" JSONB,
    "afterSummaryJson" JSONB,
    "result" "AdminAuditResult" NOT NULL,
    "errorCode" "AdminAuditErrorCode",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminActionRequest" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "requestKey" VARCHAR(36) NOT NULL,
    "action" "AdminAuditAction" NOT NULL,
    "targetType" "AdminAuditTargetType" NOT NULL,
    "targetId" VARCHAR(255) NOT NULL,
    "reason" VARCHAR(255) NOT NULL,
    "requestFingerprint" VARCHAR(64) NOT NULL,
    "requestSummaryJson" JSONB,
    "status" "AdminActionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "resultSummaryJson" JSONB,
    "errorCode" "AdminAuditErrorCode",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminActionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAuditEvent_createdAt_id_idx" ON "AdminAuditEvent"("createdAt", "id");

-- CreateIndex
CREATE INDEX "AdminAuditEvent_actorAdminId_createdAt_id_idx" ON "AdminAuditEvent"("actorAdminId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AdminAuditEvent_targetType_targetId_createdAt_id_idx" ON "AdminAuditEvent"("targetType", "targetId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AdminAuditEvent_action_result_createdAt_id_idx" ON "AdminAuditEvent"("action", "result", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AdminAuditEvent_correlationId_createdAt_id_idx" ON "AdminAuditEvent"("correlationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AdminAuditEvent_actionId_createdAt_id_idx" ON "AdminAuditEvent"("actionId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AdminActionRequest_status_updatedAt_idx" ON "AdminActionRequest"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminActionRequest_principalId_requestKey_key" ON "AdminActionRequest"("principalId", "requestKey");

-- AddForeignKey
ALTER TABLE "AdminActionRequest" ADD CONSTRAINT "AdminActionRequest_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "AdminPrincipal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE TRIGGER admin_audit_event_immutable_history
BEFORE UPDATE OR DELETE ON "AdminAuditEvent"
FOR EACH ROW EXECUTE FUNCTION mandatepay_reject_immutable_history_change();
CREATE TRIGGER admin_audit_event_no_truncate
BEFORE TRUNCATE ON "AdminAuditEvent"
FOR EACH STATEMENT EXECUTE FUNCTION mandatepay_reject_immutable_history_change();

ALTER TABLE "AdminAuditEvent"
  ADD CONSTRAINT "AdminAuditEvent_actor_check" CHECK (
    ("actorAdminId" IS NOT NULL AND "actorUserId" IS NOT NULL AND "role" IS NOT NULL)
    OR ("actorAdminId" IS NULL AND "actorUserId" IS NULL AND "role" IS NULL
      AND "action" IN ('ADMIN_LOGIN_FAILED', 'ADMIN_REAUTH_FAILED'))
  ),
  ADD CONSTRAINT "AdminAuditEvent_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 255),
  ADD CONSTRAINT "AdminAuditEvent_result_check" CHECK (
    ("result" = 'SUCCESS' AND "errorCode" IS NULL)
    OR ("result" = 'FAILURE' AND "errorCode" IS NOT NULL)
    OR "result" = 'PENDING'
  ),
  ADD CONSTRAINT "AdminAuditEvent_summary_check" CHECK (
    ("beforeSummaryJson" IS NULL OR jsonb_typeof("beforeSummaryJson") = 'object')
    AND ("afterSummaryJson" IS NULL OR jsonb_typeof("afterSummaryJson") = 'object')
  );
