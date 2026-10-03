ALTER TABLE "Payment"
  ADD COLUMN "paypalOrderRequestId" VARCHAR(36),
  ADD COLUMN "paypalCaptureRequestId" VARCHAR(36);

CREATE UNIQUE INDEX "Payment_paypalOrderRequestId_key"
  ON "Payment" ("paypalOrderRequestId");

CREATE UNIQUE INDEX "Payment_paypalCaptureRequestId_key"
  ON "Payment" ("paypalCaptureRequestId");
