DROP INDEX IF EXISTS "Refund_idempotencyKey_key";

CREATE UNIQUE INDEX "Refund_userId_idempotencyKey_key"
  ON "Refund" ("userId", "idempotencyKey");
