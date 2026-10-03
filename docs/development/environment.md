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

| Consumer                                | Files and settings                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API `dev` / `start`                     | Root plus `apps/api` layers, loaded before application imports; supported server/auth/database/AI/Channel3/PayPal settings only.                          |
| Next.js dev/build/start/type generation | Next.js loads `apps/web` files normally; config fills root defaults for server-only `API_URL` / `APP_URL`. Workspace and injected values keep precedence. |
| Prisma generate/migrate/status/seed     | Root plus `packages/database` layers; only `DATABASE_URL` / `TEST_DATABASE_URL`.                                                                          |
| PostgreSQL integration tests            | Root plus the tested API/database workspace in test mode; only database URLs are loaded.                                                                  |
| Playwright                              | Root plus database workspace in test mode; dedicated test URL with existing explicit test auth/AI/PayPal fixtures.                                        |
| Unit tests                              | Do not load private environment files. Environment-loader tests use temporary fixtures.                                                                   |

Provider, auth and database secrets from root files are never imported into Next.js by this loader. Keep secrets out of `apps/web/.env*` and all `NEXT_PUBLIC_*` variables; Next.js's native workspace/public loading still applies. Each consumer loads its own allowed settings; root files are not exported into every Turbo process.

Prisma and the API still need the same application `DATABASE_URL` unless an intentional override is required. `TEST_DATABASE_URL` must target a separate database ending in `_test`; no root file or override bypasses test isolation checks. The local database helper preserves existing nonempty workspace settings and generates private files with mode 0600.

Turbo hashes root environment files and loader source globally, and workspace files for affected build/typecheck/test tasks. Injected server URLs and active API development knobs are declared for strict mode. The web task overrides backend environment declarations to exclude provider/database credentials in strict mode; loose mode and direct shell invocations still inherit the caller's environment. No environment file is a cached output or committed source.

Templates list active configuration. Planned flags for Vault, AG Studio, voice, off-session payments, recurrence and price-watch do not implement those features and are not treated as working switches. PayPal remains Sandbox-only.

Production authentication defaults to required email verification. Set `RESEND_API_KEY` and a verified bare sender email in `AUTH_EMAIL_FROM`; `AUTH_REQUIRE_EMAIL_VERIFICATION=false` is rejected in production. For local verification/recovery testing, configure delivery and set `AUTH_REQUIRE_EMAIL_VERIFICATION=true`. Development/test defaults retain immediate signup. Never log verification/reset tokens or export mail credentials. Unit/integration tests use an injected fake sender, not real messages.

Run `pnpm test:env` for precedence, scoped imports, explicit clearing, syntax, startup preload and failure handling. Run the usual checks and isolated integration/browser suites for application regressions.
