# Optional Render deployment

Hosted deployment and live Sandbox buyer verification were deferred by the user. No services have been created. The root `render.yaml` is a reviewable configuration template, based on [Render's Blueprint reference](https://render.com/docs/blueprint-spec). It has **not** been validated against a live Render workspace; Render validates it when you import it. Automatic deploys are disabled.

## What the Blueprint defines

| Resource                       | Purpose                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `mandatepay-web`               | Next.js customer app and same-origin BFF (`/api/*` → API).                             |
| `mandatepay-admin`             | Next.js operator console and admin BFF (`/api/admin/*` → API).                         |
| `mandatepay-api`               | Fastify API; runs `migrate:deploy` as its pre-deploy command. Health: `/health/ready`. |
| `mandatepay-webhook-recovery`  | Cron (every 2 min): `pnpm --filter @mandatepay/api worker:webhooks`.                   |
| `mandatepay-payment-reconcile` | Cron (every 5 min): `pnpm --filter @mandatepay/api worker:reconcile`.                  |
| `mandatepay-database`          | PostgreSQL 17.                                                                         |

Plans use Render identifiers (`starter` for web services and crons, `basic-256mb` for Postgres). They are a starting point; change them in `render.yaml` or the dashboard to fit your budget. All resources share one region. Builds run at the monorepo root so shared packages and the lockfile are available. A failed migration stops the API deploy.

## Generated and shared values

- `AUTH_SECRET`, `INTERNAL_PROXY_SECRET` and `TOKEN_ENCRYPTION_KEY` are generated once on `mandatepay-api`. Web and admin read `INTERNAL_PROXY_SECRET` from the API service, so all three always hold the same value. Rotating it means updating the API value and redeploying web and admin together.
- `INTERNAL_PROXY_SECRET` is required by the API in production. The BFFs send it with the browser's IP (the first `X-Forwarded-For` hop from Render's edge, or the socket address). The API trusts that IP only when the secret matches; otherwise it uses the connecting address. Without it every user would share the authentication rate-limit bucket of the web server.
- `TRUST_PROXY` is intentionally unset. Set it to a hop count only if you have confirmed the API is reachable exclusively through that many proxies; it affects direct API traffic such as PayPal webhooks, not BFF traffic.
- `APP_URL`, `WEB_ORIGIN`, `ADMIN_ORIGIN` and `API_URL` come from each service's `RENDER_EXTERNAL_URL`. When adding custom domains, use complete public HTTPS URLs and update `APP_URL` with `WEB_ORIGIN`, and `ADMIN_ORIGIN` on both the API and admin services.

## Deploy steps

1. Push the branch you want to deploy to the repository Render will read.
2. In Render, choose **New → Blueprint**, select the repository and review the plan for each resource before applying.
3. Fill every `sync: false` value on `mandatepay-api`: `RESEND_API_KEY`, `AUTH_EMAIL_FROM` (a sender on a domain verified in Resend), `OPENAI_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (Sandbox REST app only), and `DEMO_ACCOUNT_EMAIL` / `DEMO_ACCOUNT_PASSWORD` / optional `DEMO_ACCOUNT_NAME`. Leave `PAYPAL_WEBHOOK_ID` empty for now. Production authentication fails closed without verified-email delivery.
4. Deploy. Confirm `https://<api-host>/health/ready` returns `{"status":"ready"}` and the web and admin URLs load.
5. Register the PayPal webhook (below), set `PAYPAL_WEBHOOK_ID` on the API and redeploy the API and both crons.
6. Provision the demo account (below).

Do not copy local `.env` files into source or build artifacts. Credentials stay in Render's protected environment values.

## PayPal Sandbox webhook

In the same PayPal Sandbox REST app, add a webhook with the URL:

```
https://<api-host>/api/webhooks/paypal
```

where `<api-host>` is the API service's `onrender.com` host (or its custom domain). Subscribe to order-approved, capture-completed, capture-denied and capture-refunded events (and, when saved PayPal is enabled, `VAULT.PAYMENT-TOKEN.CREATED` and `VAULT.PAYMENT-TOKEN.DELETED`), then copy the webhook ID into `PAYPAL_WEBHOOK_ID`. Use a separate personal Sandbox buyer and record the actual order, capture, refund and verified webhook results. Do not count the injected test transport as a live financial demonstration.

## Demo account for reviewers

Production requires verified email, and the seed user has no password, so reviewers need a provisioned account. Open the **Shell** of `mandatepay-api` (where `DEMO_ACCOUNT_*` are set) and run:

```sh
pnpm --filter @mandatepay/api demo:account --with-demo-mandate
```

The command:

- creates the user through Better Auth's own sign-up API (identical password hashing), marks the email verified and sends no email;
- rejects weak passwords (12–128 characters, three character classes, no common words or email name) and never prints the password;
- is safe to re-run: an existing account keeps its password unless you add `--reset-password`, which also revokes its sessions; a passwordless existing user receives the configured password; an account disabled by an administrator is left untouched and the command fails;
- with `--with-demo-mandate`, creates one ACTIVE mandate for 30 days, unless an active demo mandate already exists: Sony or Bose headphones, category Headphones, new condition only, up to $180.00 per transaction, automatic spending up to $150.00, no extra approval for new merchants, USD;
- leaves autonomous purchasing off. The reviewer enables it in Settings when the demo calls for it.

It prints one JSON line with the user ID and what changed. Share the credentials with reviewers through a private channel, never in the repository.

To create the operator account for the admin console, use a separate email: either sign up through the web app and verify by email, or run the same command with operator values in `DEMO_ACCOUNT_*` (then restore the reviewer values). Grant the singleton administrator role from the API shell with `MANDATEPAY_ADMIN_USER_ID=<user-id> pnpm --filter @mandatepay/database admin:bootstrap`.

## Recovery jobs

The webhook recovery cron reads only previously verified durable inbox records, claims database leases, fetches authoritative provider state and retries with bounded backoff. It never creates or captures a payment. Five total processing attempts are allowed by default; exhausted records remain visible in the database for investigation. The payment reconcile cron runs `worker:reconcile` on the same database and PayPal Sandbox credentials. Workers print aggregate counts without payloads or credentials. Monitor job failures, exhausted events, database health and pending financial outcomes.

The synchronous purchase flow remains in the API because human review and checkout are interactive. This template uses Render Cron Jobs, not the Render Workflows SDK. Do not describe Render Workflows as integrated or hosted acceptance as passed. Unknown order/capture/refund outcomes retain reservations and must be reconciled through the existing idempotent endpoints or verified events; never release holds merely because a timeout elapsed.

## Before opening a hosted demo

Run the full checks, migrations and browser workflow from a fresh clone; verify HTTPS cookies, security headers (CSP, HSTS), signup verification, password reset/session invalidation, cross-user denial, per-user authentication rate limits behind the BFF, duplicate capture/refund protection, real webhook delivery and a recovery retry. Configure backups and alerting. The in-memory request limiters assume a single API replica; add shared limits before scaling replicas. Keep live payments, recurring purchases and voice disabled until their separate implementation and consent gates are met. Saved PayPal (Vault) autopay is implemented for Sandbox; enable it only after the setup below and a recorded Sandbox run.

## Saved PayPal (Vault) for autonomous purchases

Buyer-not-present payment with a saved PayPal method is implemented (see [VAULT_AUTONOMY.md](../implementation/VAULT_AUTONOMY.md)) but has only been verified against simulated PayPal responses. It stays off until all of the following are true:

1. **Enable Vault on the Sandbox REST app.** In the PayPal Developer Dashboard open **Apps & Credentials → (Sandbox) → your REST app → Features / Accept payments → Advanced options** and turn on **Vault** (labelled “Save payment methods” in newer dashboards). Save. Without it PayPal answers `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`; MandatePay then falls back to the normal PayPal checkout and charges nothing automatically. MandatePay cannot detect this setting in advance.
2. **Encryption key.** `TOKEN_ENCRYPTION_KEY` on `mandatepay-api` must decode to exactly 32 bytes (64 hex characters, or base64/base64url such as `openssl rand -base64 32`). The Blueprint generates it; if the generated value is not 32 bytes, replace it with `openssl rand -base64 32`. When the key is missing or invalid the API logs `paypal_vault_disabled` once and Settings shows saving as unavailable. **Rotating or losing this key makes stored tokens unreadable**: affected users fall back to checkout and must save PayPal again; removal of an unreadable token stays pending (it is never charged) until it is deleted in PayPal.
3. **Webhook events.** Add `VAULT.PAYMENT-TOKEN.CREATED` and `VAULT.PAYMENT-TOKEN.DELETED` to the existing webhook so a buyer who removes MandatePay in their PayPal account is revoked locally. Also keep `CHECKOUT.ORDER.COMPLETED` and `PAYMENT.CAPTURE.COMPLETED`: they settle an automatic payment whose create response was lost.
4. **Return URLs.** Consent returns to `${APP_URL}/settings?vault=return` (or `?vault=cancel`). `APP_URL` must be the public HTTPS web URL.
5. **Sandbox evidence.** With a personal Sandbox buyer: save PayPal in Settings, turn on automatic permissions, ask the agent for a purchase within the automatic limit, and record the order id, capture id and webhook deliveries. Then remove the method in Settings and in a second run revoke it from the buyer’s PayPal account. Do not present the simulated provider as this evidence.
