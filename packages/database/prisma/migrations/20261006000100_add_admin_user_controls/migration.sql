-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_PROPOSAL_RE_EVALUATED';

-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'USER_DISABLED';
ALTER TYPE "AuditEventType" ADD VALUE 'USER_ENABLED';
ALTER TYPE "AuditEventType" ADD VALUE 'USER_SESSIONS_REVOKED';

-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "disabledAt" TIMESTAMP(3),
  ADD COLUMN "disabledReason" VARCHAR(255),
  ADD COLUMN "disabledByAdminId" TEXT,
  ADD COLUMN "accessVersion" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "User_disabledAt_idx" ON "User"("disabledAt");

ALTER TABLE "User"
  ADD CONSTRAINT "User_disabled_check" CHECK (
    ("disabledAt" IS NULL AND "disabledReason" IS NULL)
    OR (
      "disabledAt" IS NOT NULL
      AND "disabledReason" IS NOT NULL
      AND length(btrim("disabledReason")) BETWEEN 1 AND 255
    )
  ),
  ADD CONSTRAINT "User_accessVersion_check" CHECK ("accessVersion" >= 0);

ALTER TABLE "User"
  ADD CONSTRAINT "User_disabledByAdminId_fkey"
  FOREIGN KEY ("disabledByAdminId") REFERENCES "AdminPrincipal"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AdminNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authorAdminId" TEXT NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminNote_userId_createdAt_id_idx" ON "AdminNote"("userId", "createdAt", "id");
CREATE INDEX "AdminNote_authorAdminId_idx" ON "AdminNote"("authorAdminId");

ALTER TABLE "AdminNote"
  ADD CONSTRAINT "AdminNote_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdminNote"
  ADD CONSTRAINT "AdminNote_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 2000);

CREATE TRIGGER admin_note_immutable_history
BEFORE UPDATE OR DELETE ON "AdminNote"
FOR EACH ROW EXECUTE FUNCTION mandatepay_reject_immutable_history_change();

CREATE TRIGGER admin_note_no_truncate
BEFORE TRUNCATE ON "AdminNote"
FOR EACH STATEMENT EXECUTE FUNCTION mandatepay_reject_immutable_history_change();
