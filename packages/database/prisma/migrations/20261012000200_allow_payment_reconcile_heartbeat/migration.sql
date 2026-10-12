-- Widens the worker allowlist so the payment reconcile job can record heartbeats.
ALTER TABLE "WorkerHeartbeat" DROP CONSTRAINT "WorkerHeartbeat_worker_check";
ALTER TABLE "WorkerHeartbeat"
  ADD CONSTRAINT "WorkerHeartbeat_worker_check"
  CHECK ("worker" IN ('paypal-webhook-recovery', 'paypal-payment-reconcile'));
