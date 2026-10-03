ALTER TABLE "Mandate"
  ADD COLUMN "creationRequestKey" VARCHAR(255),
  ADD COLUMN "creationFingerprint" VARCHAR(128);

CREATE UNIQUE INDEX "Mandate_userId_creationRequestKey_key"
  ON "Mandate" ("userId", "creationRequestKey");
