-- Additive only: PayPal Vault consent state, payment source and audit event types.
ALTER TYPE "PaymentProfileStatus" ADD VALUE IF NOT EXISTS 'SETUP_PENDING';
ALTER TYPE "PaymentProfileStatus" ADD VALUE IF NOT EXISTS 'ACTIVE';
ALTER TYPE "PaymentProfileStatus" ADD VALUE IF NOT EXISTS 'REMOVAL_PENDING';

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'PAYMENT_METHOD_SETUP_STARTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'PAYMENT_METHOD_SAVED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'PAYMENT_METHOD_REMOVAL_REQUESTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'PAYMENT_METHOD_REVOKED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'AUTONOMOUS_PAYMENT_STARTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'AUTONOMOUS_PAYMENT_COMPLETED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'AUTONOMOUS_PAYMENT_FALLBACK';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'AUTONOMOUS_PAYMENT_FAILED';

CREATE TYPE "PaymentSource" AS ENUM ('CHECKOUT', 'VAULT');

ALTER TABLE "Payment"
  ADD COLUMN "paymentSource" "PaymentSource" NOT NULL DEFAULT 'CHECKOUT';

ALTER TABLE "PaymentProfile"
  ADD COLUMN "paypalVaultIdHash" VARCHAR(64),
  ADD COLUMN "setupTokenId" VARCHAR(128),
  ADD COLUMN "setupRequestId" VARCHAR(36),
  ADD COLUMN "setupApprovalUrl" VARCHAR(2048),
  ADD COLUMN "setupExpiresAt" TIMESTAMP(3),
  ADD COLUMN "paymentTokenRequestId" VARCHAR(36),
  ADD COLUMN "consentVersion" VARCHAR(32),
  ADD COLUMN "consentedAt" TIMESTAMP(3),
  ADD COLUMN "payerEmailMasked" VARCHAR(320),
  ADD COLUMN "activatedAt" TIMESTAMP(3),
  ADD COLUMN "removalRequestedAt" TIMESTAMP(3),
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorCode" VARCHAR(128);

CREATE UNIQUE INDEX "PaymentProfile_paypalVaultIdHash_key" ON "PaymentProfile"("paypalVaultIdHash");
CREATE UNIQUE INDEX "PaymentProfile_setupRequestId_key" ON "PaymentProfile"("setupRequestId");
CREATE UNIQUE INDEX "PaymentProfile_paymentTokenRequestId_key" ON "PaymentProfile"("paymentTokenRequestId");
