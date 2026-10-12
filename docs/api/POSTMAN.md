# Manual API workflow

Import `MandatePay.postman_collection.json` into Postman. Set local `apiUrl` and the trusted frontend `appUrl`; use an ephemeral account and Postman's cookie jar. Keep credentials in private local values and never export them. Start the database, apply migrations and run both services using the README first.

Create and activate a reviewed mandate in the app, then set its exact `mandateId`. The collection exposes parse, policy simulation, search, streamed and non-streamed shopping chat, proposal, policy, approval, Sandbox order/capture/status, refund/refund status, saved PayPal (Vault) consent and autopay, analytics and audit endpoints. Save returned local proposal/payment IDs into collection variables. A PayPal order ID is different from the local `paymentId` used by capture, status, receipt and refund endpoints.

Use a distinct UUID request key for each intentional shopping/proposal/refund request. Keep the same key and payload for a retry after network failure. Do not run the collection as an unattended financial batch: order creation, approval, capture, autopay and refunds are explicit actions. Open the real approval URL with a separate personal Sandbox buyer before capture. Amounts are integer cents; the partial example is $20.00. All prices and purchase totals come from the server.

Notes for the newer requests (exact shapes are in [the commerce API contract](../architecture/commerce-api.md)):

- **PayPal status** reports `environment` as `sandbox` or `live`. Use this collection only against Sandbox.
- **Create Sandbox order** answers `202` with `pending: true` when PayPal's outcome is unknown; sending it again replays the same PayPal request ID. `422 PAYPAL_REQUEST_REJECTED` means PayPal created nothing.
- **Check Sandbox order status** and **Check refund status** only read PayPal; they never create an order, capture or refund.
- **Shopping agent (streamed)** returns Server-Sent Events (`step`, then one `result` or `error`). Postman shows the raw event stream; the `result` data equals the non-streamed chat body, including `excludedProducts`.
- **Simulate a purchase against a mandate** is read-only: it shows the AgentGuard decision and `explanation` for hypothetical facts without creating anything.
- **Saved PayPal**: read **Saved PayPal method**, set `vaultConsentVersion` to its `currentConsentVersion` only after reading the consent text in Settings, send **Start saving PayPal (consent)**, approve at PayPal with a personal Sandbox buyer, then **Complete saving PayPal**. Vault needs `TOKEN_ENCRYPTION_KEY` on the API.
- **Autopay with saved PayPal** is a financial write. Check **Autopay preview** first; only AgentGuard ALLOW proposals within the automatic limit are eligible, and every other case keeps the normal checkout.

Webhook signature headers are not fabricated in this collection. Qualify real webhooks only after registering an HTTPS endpoint. Automated financial tests use a separately injected fake transport; Postman requests reach the configured application and Sandbox services.

The collection is provided for manual inspection; no Postman live financial execution is claimed. Complete local automated evidence and deferred live/hosting gates are recorded in `docs/implementation/PROGRESS.md`.
