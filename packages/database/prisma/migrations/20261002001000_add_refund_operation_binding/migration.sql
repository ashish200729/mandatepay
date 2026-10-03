ALTER TABLE "Refund"
  ADD COLUMN "paypalRequestId" VARCHAR(36),
  ADD COLUMN "requestFingerprint" VARCHAR(128);

CREATE UNIQUE INDEX "Refund_paypalRequestId_key"
  ON "Refund" ("paypalRequestId");
