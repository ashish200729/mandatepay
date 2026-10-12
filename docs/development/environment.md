# Environment configuration

Root `.env` files provide shared defaults. The API, Next.js server and Prisma commands also support workspace files. Existing ignored credentials remain in place; moving or duplicating them is optional.

## Setup and precedence

Copy `.env.example` to root `.env` and fill the settings you need. For overrides, create `apps/api/.env`, `apps/web/.env` or `packages/database/.env`; keep only the keys you want to override. Copying a whole workspace example with empty values intentionally clears matching root settings.

Within each directory, precedence is highest to lowest:

1. `.env.<mode>.local`
2. `.env.<mode>`
3. `.env.local` (skipped in test mode)
4. `.env`

Workspace files override root files, even root mode-specific files. Shell/CI/deployment values override every file, including explicitly empty values. Missing files are optional; unreadable files fail startup without logging their contents. `.env.example` is never loaded. Values use Node's dotenv syntax, including quoted/multiline values and comments; root/API/database values do not expand `$VARIABLE` references. Write complete URLs and keys.

Select modes with `NODE_ENV=development`, `test` or `production` in the invoking environment. API/database default to development when unset; Next.js selects its usual mode for dev/build/start. Do not put `NODE_ENV` in root defaults. Set `NODE_ENV=production` when starting the production API so existing production validation applies.

## Consumers and boundaries

| Consumer                                | Files and settings                                                                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API `dev` / `start`                     | Root plus `apps/api` layers, loaded before application imports; supported server/auth/database/AI/Channel3/PayPal settings only.                                                                                                                     |
| Next.js dev/build/start/type generation | Next.js loads `apps/web` / `apps/admin` files normally; config fills root defaults for server-only `API_URL` / `APP_URL` / `INTERNAL_PROXY_SECRET` (admin also `ADMIN_ORIGIN` / `ADMIN_ENVIRONMENT`). Workspace and injected values keep precedence. |
| Prisma generate/migrate/status/seed     | Root plus `packages/database` layers; only `DATABASE_URL` / `TEST_DATABASE_URL`.                                                                                                                                                                     |
| PostgreSQL integration tests            | Root plus the tested API/database workspace in test mode; only database URLs are loaded.                                                                                                                                                             |
| Playwright                              | Root plus database workspace in test mode; dedicated test URL with existing explicit test auth/AI/PayPal fixtures.                                                                                                                                   |
| Unit tests                              | Do not load private environment files. Environment-loader tests use temporary fixtures.                                                                                                                                                              |

Provider, auth and database secrets from root files are never imported into Next.js by this loader. The only shared secret the BFFs receive is `INTERNAL_PROXY_SECRET`, which grants no provider, database or session access. Keep secrets out of `apps/web/.env*` and all `NEXT_PUBLIC_*` variables; Next.js's native workspace/public loading still applies. Each consumer loads its own allowed settings; root files are not exported into every Turbo process.

Prisma and the API still need the same application `DATABASE_URL` unless an intentional override is required. `TEST_DATABASE_URL` must target a separate database ending in `_test`; no root file or override bypasses test isolation checks. The local database helper preserves existing nonempty workspace settings and generates private files with mode 0600.

Turbo hashes root environment files and loader source globally, and workspace files for affected build/typecheck/test tasks. Injected server URLs and active API development knobs are declared for strict mode. The web task overrides backend environment declarations to exclude provider/database credentials in strict mode; loose mode and direct shell invocations still inherit the caller's environment. No environment file is a cached output or committed source.

Templates list active configuration. Planned flags for Vault, AG Studio, voice, off-session payments, recurrence and price-watch do not implement those features and are not treated as working switches. PayPal remains Sandbox-only.

Production authentication defaults to required email verification. Set `RESEND_API_KEY` and a verified bare sender email in `AUTH_EMAIL_FROM`; `AUTH_REQUIRE_EMAIL_VERIFICATION=false` is rejected in production. For local verification/recovery testing, configure delivery and set `AUTH_REQUIRE_EMAIL_VERIFICATION=true`. Development/test defaults retain immediate signup. Never log verification/reset tokens or export mail credentials. Unit/integration tests use an injected fake sender, not real messages.

## Client addresses, proxies and security headers

| Variable                | Default                | Required                                                        |
| ----------------------- | ---------------------- | --------------------------------------------------------------- |
| `INTERNAL_PROXY_SECRET` | unset                  | API in production (32+ characters); same value on web and admin |
| `TRUST_PROXY`           | unset (no proxy trust) | Never; optional hop count 0–10 for direct API traffic           |

The web and admin BFFs forward the browser's address (the first `X-Forwarded-For` hop, which Next.js fills from the socket when no proxy sets it) together with `INTERNAL_PROXY_SECRET`. The API compares the secret in constant time and only then keys authentication rate limits on that address; a forwarded address without the secret, with a wrong secret or with an invalid value is ignored. Credential sign-in/sign-up is additionally limited per normalized email (10 attempts per 15 minutes) regardless of address. Locally the secret is optional: without it the API uses its socket address, which is the loopback BFF. Generate a value with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and put it in the root `.env` to exercise the production path. `TRUST_PROXY` makes Fastify read `X-Forwarded-For` for direct API requests; set it only when the API cannot be reached except through that many proxies.

The API adds `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Cross-Origin-Resource-Policy` and, in production, HSTS. Web and admin send a Content-Security-Policy (`apps/web/security-headers.mjs`, `apps/admin/security-headers.mjs`) without nonces: `script-src` keeps `'unsafe-inline'` for the App Router bootstrap, and `'unsafe-eval'` plus HMR websockets are added only by the development server. Production builds also send HSTS. PayPal approval is a top-level navigation, so the web policy only lists PayPal in `form-action`.

## Demo account

`pnpm --filter @mandatepay/api demo:account [--reset-password] [--with-demo-mandate]` (after `pnpm --filter @mandatepay/api... build`) reads `DEMO_ACCOUNT_EMAIL`, `DEMO_ACCOUNT_PASSWORD` and optional `DEMO_ACCOUNT_NAME` (default `MandatePay Demo`) through the API loader, plus the usual `DATABASE_URL` / `AUTH_SECRET` / `APP_URL`. It creates a verified account through Better Auth, rejects weak passwords, never prints the password and is idempotent; see [the Render guide](../deployment/RENDER.md#demo-account-for-reviewers) for behavior. The server itself never reads these variables. Keep real values in ignored files or deployment settings.

Run `pnpm test:env` for precedence, scoped imports, explicit clearing, syntax, startup preload and failure handling. Run the usual checks and isolated integration/browser suites for application regressions.

## Saved PayPal (Vault) encryption key

| Variable               | Default | Required                                                    |
| ---------------------- | ------- | ----------------------------------------------------------- |
| `TOKEN_ENCRYPTION_KEY` | unset   | Only to enable saved PayPal; exactly 32 bytes (hex/base64). |

`TOKEN_ENCRYPTION_KEY` encrypts PayPal Vault payment token ids at rest (AES-256-GCM, bound to the owning user) and keys the lookup hash used to match verified `VAULT.PAYMENT-TOKEN.*` webhooks. Generate one with `openssl rand -base64 32` or `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` and put it in the root `.env` (API only; never in `apps/web` or a `NEXT_PUBLIC_*` variable). Missing, short or malformed keys disable saving PayPal instead of weakening encryption; checkout with PayPal approval keeps working. The Sandbox REST app must also have Vault enabled; see [the Render guide](../deployment/RENDER.md#saved-paypal-vault-for-autonomous-purchases).

Tests never use a real key or PayPal: integration tests generate a random key per run, and the browser test stack needs `TOKEN_ENCRYPTION_KEY` set to a loopback-only random value in `scripts/e2e-services.mjs` plus the simulated Vault endpoints in `scripts/e2e-paypal-provider.mjs`.

## Mandate credential signing key

| Variable                        | Default | Required                                                      |
| ------------------------------- | ------- | ------------------------------------------------------------- |
| `MANDATE_SIGNING_KEY`           | unset   | Production. EC P-256 **private** JWK as one JSON line.        |
| `MANDATE_SIGNING_PREVIOUS_JWKS` | unset   | Optional. Retired **public** JWKs (`{"keys":[...]}` or `[]`). |

The API signs AP2-shaped mandate credentials with ES256 (see [AP2 mandates](../architecture/AP2_MANDATES.md)). Generate a key with `pnpm --silent --filter @mandatepay/api mandate:keygen`: stdout is the private JWK (put it only in an ignored `.env` or the deployment secret store), stderr shows its `kid` and public JWK. The API refuses to boot in production without it. In development and test an unset key is replaced by a temporary per-process key with a one-time warning, so credentials issued before a restart stop verifying; the browser test stack needs no key. To rotate, set the new private key and add the old public JWK to `MANDATE_SIGNING_PREVIOUS_JWKS`; credentials from a key that is in neither variable no longer verify. Private keys are rejected in the previous set. The public keys are served at `GET /.well-known/jwks.json` (and `/api/credentials/jwks` through the web BFF).
