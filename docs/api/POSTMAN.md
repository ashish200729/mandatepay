# Manual API workflow

Import `MandatePay.postman_collection.json` into Postman. Set local `apiUrl` and the trusted frontend `appUrl`; use an ephemeral account and Postman's cookie jar. Keep credentials in private local values and never export them. Start the database, apply migrations and run both services using the README first.

Create and activate a reviewed mandate in the app, then set its exact `mandateId`. The collection exposes parse, search, proposal, policy, approval, Sandbox order/capture/refund, analytics and audit endpoints. Save returned local proposal/payment IDs into collection variables. A PayPal order ID is different from the local `paymentId` used by capture, receipt and refund endpoints.

Use a distinct UUID request key for each intentional shopping/proposal/refund request. Keep the same key and payload for a retry after network failure. Do not run the collection as an unattended financial batch: order creation, approval, capture and refunds are explicit actions. Open the real approval URL with a separate personal Sandbox buyer before capture. Amounts are integer cents; the partial example is $20.00. All prices and purchase totals come from the server.

Webhook signature headers are not fabricated in this collection. Qualify real webhooks only after registering an HTTPS endpoint. Automated financial tests use a separately injected fake transport; Postman requests reach the configured application and Sandbox services.

The collection is provided for manual inspection; no Postman live financial execution is claimed. Complete local automated evidence and deferred live/hosting gates are recorded in `docs/implementation/PROGRESS.md`.
