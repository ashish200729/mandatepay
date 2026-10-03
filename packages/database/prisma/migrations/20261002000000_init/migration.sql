-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PaymentProfileStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "MandateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "MandateRuleType" AS ENUM ('ALLOWED_BRAND', 'BLOCKED_BRAND', 'ALLOWED_CATEGORY', 'BLOCKED_CATEGORY', 'ALLOWED_MERCHANT', 'BLOCKED_MERCHANT', 'REQUIRED_CONDITION', 'REQUIRED_SPECIFICATION', 'BLOCKED_SPECIFICATION', 'ALLOWED_CURRENCY');

-- CreateEnum
CREATE TYPE "RuleOperator" AS ENUM ('EQUALS', 'NOT_EQUALS', 'IN', 'NOT_IN', 'CONTAINS', 'NOT_CONTAINS', 'GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL');

-- CreateEnum
CREATE TYPE "ProductCondition" AS ENUM ('NEW', 'REFURBISHED', 'USED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PolicyDecisionType" AS ENUM ('ALLOW', 'REQUIRE_APPROVAL', 'BLOCK');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('DRAFT', 'PROPOSED', 'POLICY_CHECKED', 'BLOCKED', 'AWAITING_APPROVAL', 'APPROVED', 'AUTHORIZED', 'PAYPAL_ORDER_CREATED', 'PAYMENT_PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'APPROVED', 'CAPTURE_PENDING', 'COMPLETED', 'DENIED', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReservationWindow" AS ENUM ('TRANSACTION', 'DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('USER_CREATED', 'MANDATE_PARSE_REQUESTED', 'MANDATE_PARSED', 'MANDATE_CREATED', 'MANDATE_ACTIVATED', 'MANDATE_UPDATED', 'MANDATE_PAUSED', 'MANDATE_RESUMED', 'MANDATE_REVOKED', 'MANDATE_EXPIRED', 'PRODUCT_SEARCH_REQUESTED', 'PRODUCT_SEARCH_COMPLETED', 'PRODUCT_SELECTED', 'PURCHASE_PROPOSAL_CREATED', 'POLICY_EVALUATION_STARTED', 'POLICY_ALLOWED', 'POLICY_APPROVAL_REQUIRED', 'POLICY_BLOCKED', 'APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED', 'APPROVAL_EXPIRED', 'SPEND_RESERVED', 'SPEND_RESERVATION_RELEASED', 'SPEND_RESERVATION_CONSUMED', 'PAYPAL_ORDER_CREATED', 'PAYPAL_ORDER_APPROVED', 'PAYMENT_CAPTURE_REQUESTED', 'PAYMENT_CAPTURED', 'PAYMENT_FAILED', 'PAYPAL_WEBHOOK_RECEIVED', 'REFUND_REQUESTED', 'REFUND_APPROVED', 'PAYPAL_REFUND_CREATED', 'REFUND_COMPLETED', 'REFUND_FAILED');

-- CreateEnum
CREATE TYPE "AuditEntityType" AS ENUM ('USER', 'PAYMENT_PROFILE', 'MANDATE', 'MANDATE_VERSION', 'MANDATE_RULE', 'PRODUCT_SNAPSHOT', 'PURCHASE_PROPOSAL', 'POLICY_DECISION', 'APPROVAL', 'SPEND_RESERVATION', 'PAYMENT', 'REFUND', 'WEBHOOK_EVENT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "name" VARCHAR(200),
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "globalAutonomousPurchasingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" VARCHAR(64),
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" VARCHAR(255) NOT NULL,
    "providerId" VARCHAR(128) NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" VARCHAR(320) NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paypalCustomerId" VARCHAR(255),
    "paypalVaultIdEncrypted" TEXT,
    "status" "PaymentProfileStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mandate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "originalPrompt" TEXT NOT NULL,
    "status" "MandateStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "autoSpendLimit" BIGINT NOT NULL,
    "transactionLimit" BIGINT NOT NULL,
    "dailyLimit" BIGINT,
    "weeklyLimit" BIGINT,
    "monthlyLimit" BIGINT,
    "spendTimeZone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "activeVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MandateVersion" (
    "id" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "originalPrompt" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "autoSpendLimit" BIGINT NOT NULL,
    "transactionLimit" BIGINT NOT NULL,
    "dailyLimit" BIGINT,
    "weeklyLimit" BIGINT,
    "monthlyLimit" BIGINT,
    "spendTimeZone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MandateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MandateRule" (
    "id" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "mandateVersionId" TEXT NOT NULL,
    "ruleType" "MandateRuleType" NOT NULL,
    "operator" "RuleOperator" NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MandateRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSnapshot" (
    "id" TEXT NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "externalId" VARCHAR(255) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "brand" VARCHAR(200),
    "category" VARCHAR(200),
    "condition" "ProductCondition" NOT NULL DEFAULT 'UNKNOWN',
    "price" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "merchant" VARCHAR(255) NOT NULL,
    "metadata" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseProposal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "mandateVersionId" TEXT NOT NULL,
    "productSnapshotId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "subtotal" BIGINT NOT NULL,
    "shipping" BIGINT NOT NULL,
    "tax" BIGINT NOT NULL,
    "total" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'DRAFT',
    "proposalFingerprint" VARCHAR(128) NOT NULL,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyDecision" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "mandateVersionId" TEXT NOT NULL,
    "decision" "PolicyDecisionType" NOT NULL,
    "reasonCodes" JSONB NOT NULL,
    "rulesSnapshot" JSONB NOT NULL,
    "spendSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL DEFAULT 'PENDING',
    "proposalFingerprint" VARCHAR(128) NOT NULL,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "paypalOrderId" VARCHAR(255),
    "paypalCaptureId" VARCHAR(255),
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "failureCode" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paypalRefundId" VARCHAR(255),
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "failureCode" VARCHAR(128),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpendReservation" (
    "id" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "mandateVersionId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "window" "ReservationWindow" NOT NULL DEFAULT 'TRANSACTION',
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "SpendReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookInbox" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "providerEventId" VARCHAR(255) NOT NULL,
    "eventType" VARCHAR(255) NOT NULL,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" "AuditEventType" NOT NULL,
    "entityType" "AuditEntityType" NOT NULL,
    "entityId" VARCHAR(255) NOT NULL,
    "dedupeKey" VARCHAR(255),
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE INDEX "Verification_expiresAt_idx" ON "Verification"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProfile_userId_key" ON "PaymentProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProfile_paypalCustomerId_key" ON "PaymentProfile"("paypalCustomerId");

-- CreateIndex
CREATE INDEX "PaymentProfile_status_idx" ON "PaymentProfile"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Mandate_activeVersionId_key" ON "Mandate"("activeVersionId");

-- CreateIndex
CREATE INDEX "Mandate_userId_status_idx" ON "Mandate"("userId", "status");

-- CreateIndex
CREATE INDEX "Mandate_userId_expiresAt_idx" ON "Mandate"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "MandateVersion_mandateId_createdAt_idx" ON "MandateVersion"("mandateId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MandateVersion_mandateId_version_key" ON "MandateVersion"("mandateId", "version");

-- CreateIndex
CREATE INDEX "MandateRule_mandateId_createdAt_idx" ON "MandateRule"("mandateId", "createdAt");

-- CreateIndex
CREATE INDEX "MandateRule_mandateVersionId_ruleType_idx" ON "MandateRule"("mandateVersionId", "ruleType");

-- CreateIndex
CREATE INDEX "ProductSnapshot_brand_category_idx" ON "ProductSnapshot"("brand", "category");

-- CreateIndex
CREATE INDEX "ProductSnapshot_merchant_idx" ON "ProductSnapshot"("merchant");

-- CreateIndex
CREATE INDEX "ProductSnapshot_capturedAt_idx" ON "ProductSnapshot"("capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSnapshot_source_externalId_key" ON "ProductSnapshot"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseProposal_proposalFingerprint_key" ON "PurchaseProposal"("proposalFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseProposal_idempotencyKey_key" ON "PurchaseProposal"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PurchaseProposal_userId_createdAt_idx" ON "PurchaseProposal"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseProposal_mandateId_status_idx" ON "PurchaseProposal"("mandateId", "status");

-- CreateIndex
CREATE INDEX "PurchaseProposal_mandateVersionId_idx" ON "PurchaseProposal"("mandateVersionId");

-- CreateIndex
CREATE INDEX "PolicyDecision_proposalId_createdAt_idx" ON "PolicyDecision"("proposalId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_proposalId_key" ON "Approval"("proposalId");

-- CreateIndex
CREATE INDEX "Approval_userId_decision_expiresAt_idx" ON "Approval"("userId", "decision", "expiresAt");

-- CreateIndex
CREATE INDEX "Approval_expiresAt_idx" ON "Approval"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_proposalId_key" ON "Payment"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paypalOrderId_key" ON "Payment"("paypalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paypalCaptureId_key" ON "Payment"("paypalCaptureId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_mandateId_status_createdAt_idx" ON "Payment"("mandateId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_paypalRefundId_key" ON "Refund"("paypalRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Refund_paymentId_status_idx" ON "Refund"("paymentId", "status");

-- CreateIndex
CREATE INDEX "Refund_userId_createdAt_idx" ON "Refund"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SpendReservation_proposalId_key" ON "SpendReservation"("proposalId");

-- CreateIndex
CREATE INDEX "SpendReservation_mandateId_status_expiresAt_idx" ON "SpendReservation"("mandateId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "SpendReservation_mandateId_window_windowStart_windowEnd_idx" ON "SpendReservation"("mandateId", "window", "windowStart", "windowEnd");

-- CreateIndex
CREATE INDEX "WebhookInbox_status_receivedAt_idx" ON "WebhookInbox"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookInbox_provider_providerEventId_key" ON "WebhookInbox"("provider", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_dedupeKey_key" ON "AuditEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "AuditEvent_userId_createdAt_idx" ON "AuditEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_createdAt_idx" ON "AuditEvent"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_eventType_createdAt_idx" ON "AuditEvent"("eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentProfile" ADD CONSTRAINT "PaymentProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "MandateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MandateVersion" ADD CONSTRAINT "MandateVersion_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "Mandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MandateRule" ADD CONSTRAINT "MandateRule_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "Mandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MandateRule" ADD CONSTRAINT "MandateRule_mandateVersionId_fkey" FOREIGN KEY ("mandateVersionId") REFERENCES "MandateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseProposal" ADD CONSTRAINT "PurchaseProposal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseProposal" ADD CONSTRAINT "PurchaseProposal_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "Mandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseProposal" ADD CONSTRAINT "PurchaseProposal_mandateVersionId_fkey" FOREIGN KEY ("mandateVersionId") REFERENCES "MandateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseProposal" ADD CONSTRAINT "PurchaseProposal_productSnapshotId_fkey" FOREIGN KEY ("productSnapshotId") REFERENCES "ProductSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDecision" ADD CONSTRAINT "PolicyDecision_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "PurchaseProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDecision" ADD CONSTRAINT "PolicyDecision_mandateVersionId_fkey" FOREIGN KEY ("mandateVersionId") REFERENCES "MandateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "PurchaseProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "Mandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "PurchaseProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendReservation" ADD CONSTRAINT "SpendReservation_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "Mandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendReservation" ADD CONSTRAINT "SpendReservation_mandateVersionId_fkey" FOREIGN KEY ("mandateVersionId") REFERENCES "MandateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendReservation" ADD CONSTRAINT "SpendReservation_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "PurchaseProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
