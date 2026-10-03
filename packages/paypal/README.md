# `@mandatepay/paypal`

Server-only PayPal Sandbox client for Orders v2, Payments v2, and webhook verification. The base URL is fixed to `https://api-m.sandbox.paypal.com`; configuration cannot select live or arbitrary hosts.

The client obtains OAuth client-credentials tokens with a concurrency-safe cache and expiry margin. Mutating requests require stable `PayPal-Request-Id` values. Network, timeout, and uncertain provider failures are typed with `unknownOutcome: true` so callers reconcile provider state before retrying.

Orders use server-computed USD integer cents, `CAPTURE` intent, trusted return/cancel URLs, and validated HTTPS approval links on `sandbox.paypal.com`. Capture, full/partial refund, and GET responses validate provider IDs, statuses, USD currency, and two-decimal amounts before returning. Webhook verification requires every PayPal transmission header plus the configured webhook ID and posts to PayPal's verification endpoint; there is no unsigned fallback.

## Build and verify

```sh
pnpm --filter @mandatepay/paypal build
pnpm --filter @mandatepay/paypal typecheck
pnpm --filter @mandatepay/paypal lint
pnpm --filter @mandatepay/paypal test
```
