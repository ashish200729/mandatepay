-- Additive only: signed, AP2-shaped mandate credentials (compact JWS) and their audit events.
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MANDATE_CREDENTIAL_ISSUED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CART_MANDATE_MISMATCH';

CREATE TYPE "MandateCredentialKind" AS ENUM (
  'OPEN_PAYMENT',
  'OPEN_CHECKOUT',
  'CLOSED_CHECKOUT',
  'CLOSED_PAYMENT'
);

-- Identifiers are historical snapshots (like AdminAuditEvent): a credential is
-- evidence of what was signed and must never be rewritten by a cascade.
CREATE TABLE "MandateCredential" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "mandateId" TEXT NOT NULL,
  "mandateVersionId" TEXT NOT NULL,
  "proposalId" TEXT,
  "kind" "MandateCredentialKind" NOT NULL,
  "kid" VARCHAR(64) NOT NULL,
  "jwt" TEXT NOT NULL,
  "digest" VARCHAR(64) NOT NULL,
  "checkoutHash" VARCHAR(64),
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MandateCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MandateCredential_kind_scope_check" CHECK (
    ("kind" IN ('OPEN_PAYMENT', 'OPEN_CHECKOUT') AND "proposalId" IS NULL AND "checkoutHash" IS NULL)
    OR ("kind" IN ('CLOSED_CHECKOUT', 'CLOSED_PAYMENT') AND "proposalId" IS NOT NULL AND "checkoutHash" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "MandateCredential_digest_key" ON "MandateCredential"("digest");
CREATE UNIQUE INDEX "MandateCredential_proposalId_kind_key" ON "MandateCredential"("proposalId", "kind");
-- One open credential of each kind per immutable mandate version.
CREATE UNIQUE INDEX "MandateCredential_open_version_kind_key"
  ON "MandateCredential"("mandateVersionId", "kind")
  WHERE "proposalId" IS NULL;
CREATE INDEX "MandateCredential_mandateVersionId_kind_idx" ON "MandateCredential"("mandateVersionId", "kind");
CREATE INDEX "MandateCredential_userId_issuedAt_idx" ON "MandateCredential"("userId", "issuedAt");

CREATE TRIGGER mandate_credential_immutable_history
BEFORE UPDATE OR DELETE ON "MandateCredential"
FOR EACH ROW EXECUTE FUNCTION mandatepay_reject_immutable_history_change();
