# MandatePay

AI commerce with human-controlled spending permissions.

**AI proposes. AgentGuard authorizes. PayPal executes.**

This TypeScript monorepo implements authentication, reviewable/versioned mandates, product discovery and comparison, deterministic AgentGuard decisions, approvals, PayPal Sandbox checkout/capture/refunds, saved-PayPal (Vault) autonomous payments, verified webhook processing with recovery workers, signed AP2-shaped mandate credentials, an MCP server for external AI agents, audit history, an AG Grid Community Control Center and an operator admin console. Automated financial tests use an isolated simulated PayPal provider; live Sandbox evidence is recorded separately in [PROGRESS.md](docs/implementation/PROGRESS.md). Landing-page examples are Demo Catalog products you can reproduce in PayPal Sandbox; none is a real-money purchase.

### Highlights

- **Explainable verdicts.** Every proposal shows the recorded AgentGuard verdict with deterministic, server-templated copy (for example “Within your mandate — $139 is under your $150 automatic limit”) and a “Why?” disclosure listing each rule checked, its limit and the proposal's value. The explanation is derived from the stored decision, rules snapshot and totals; it never changes the decision.
- **Autonomy that actually pays — only inside the mandate.** After explicit consent in Settings, MandatePay saves the buyer's PayPal with Vault v3. When AgentGuard returns ALLOW within the automatic limit and autonomy is on, the server pays with the saved method — no redirect. REQUIRE_APPROVAL keeps normal PayPal checkout, BLOCK is final, and removing the method deletes the PayPal token. See [Vault autonomy](docs/implementation/VAULT_AUTONOMY.md).
- **Prompt-injection defense.** Retailer text is screened deterministically for instructions aimed at AI agents. Suspicious listings need approval; malicious ones are a hard BLOCK, and listing text reaches the model only inside delimited untrusted blocks. The Demo Catalog includes a red-team “Open Box Deal” to show it live.
- **Policy simulator.** “Try AgentGuard” on a mandate evaluates hypothetical purchases with the real engine in a read-only database transaction — nothing is proposed, reserved or paid.
- **Verifiable mandates.** Activated mandates and authorized carts are issued as ES256-signed credentials using AP2 v0.2 field names, with a public JWKS and verifier. PayPal orders are refused if the cart no longer matches its signed cart mandate. See [AP2-shaped mandates](docs/architecture/AP2_MANDATES.md).
- **Any agent, same guardrails.** The MCP server (`apps/mcp`) lets Claude, ChatGPT, Cursor or custom agents search, simulate and propose through AgentGuard with scoped, expiring, revocable tokens. They cannot approve, check out, capture or refund. See [MCP integration](docs/integrations/MCP.md).
- **Live agent progress.** Chat streams each server step (reading the mandate, searching, comparing, AgentGuard evaluating) and falls back to the JSON endpoint.
- **Transparent filtering.** Search results outside the mandate are listed under “Filtered by your mandate” with the rule each breaks; they are never offered to the model.
- **Reliable money movement.** Typed PayPal errors distinguish definitive declines from uncertain outcomes; declines release spend holds, uncertain captures are reconciled by `worker:reconcile`, and webhooks cover pending, reversed, dashboard-issued refunds and Vault token events.

Read [phase progress](docs/implementation/PROGRESS.md), [plan review](docs/implementation/PLAN_REVIEW.md), and [tool usage](docs/implementation/TOOL_USAGE.md) for qualification boundaries.

## Local setup

Use Node.js 24 (see `.nvmrc`) and pnpm 10.34.6:

```sh
npm install --global pnpm@10.34.6
pnpm install --frozen-lockfile
```

Use pnpm for workspace dependencies; the npm command above only installs pnpm itself. After pulling changes that add packages, stop the dev server, run `pnpm install --frozen-lockfile` from the repository root, then restart with `pnpm dev`. This restores missing packages such as `react-markdown` and `remark-gfm`. Running `npm i` against this pnpm installation can fail with `Cannot read properties of null (reading 'matches')`.

For the automatic local database setup, install PostgreSQL 17 and make `initdb`, `pg_ctl`, `psql`, and `createdb` available on PATH. On macOS with Homebrew:

```sh
brew install postgresql@17
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
pnpm db:local:start
pnpm --filter @mandatepay/database migrate:deploy
pnpm dev
```

The database helper creates an isolated loopback cluster under ignored `.local/postgres`, listening on port 55432. It creates separate development and test databases, generates private credentials and an authentication secret, and fills ignored environment files without replacing existing nonempty values. It does not modify an existing system PostgreSQL instance. Stop this cluster with `pnpm db:local:stop`.

Alternatively, copy root `.env.example` to ignored `.env` and configure shared PostgreSQL URLs, `AUTH_SECRET` and matching `APP_URL` / `API_URL`. Optional files in `apps/api`, `apps/web` and `packages/database` override shared settings; shell/CI values have highest priority. Keep only keys you want to override in workspace files: empty values explicitly clear root settings. `TEST_DATABASE_URL` must name a dedicated database ending in `_test`; tests reject a shared development/production database. See [environment configuration](docs/development/environment.md) for mode-specific/local files and secret boundaries.

On subsequent local starts, use `pnpm dev:local` to start the existing database, apply pending migrations, and launch the web, API and admin together. Stop existing development servers first so their ports are available.

- Web: http://localhost:3000
- Admin: http://localhost:3001
- API liveness: http://localhost:4000/health
- Database/auth readiness: http://localhost:4000/health/ready

Sign up at `/signup`, open **Mandates → New mandate**, review the AI-generated rules, save the draft, then activate it explicitly. Select **Use demo mandate** for the example rules. `/chat` runs the limited shopping agent under a selected active mandate (Enter sends, Shift+Enter adds a line); structured discovery/comparison remains available and works without the AI service. Prepare a proposal, review required approval, then continue to Sandbox checkout. Use a separate personal Sandbox buyer for PayPal approval. `/orders` shows server-confirmed payment/refund facts; `/dashboard` shows owned analytics, natural-language filters and policy/audit detail links. Refund chat remains available without an active purchasing mandate and prepares reviewable details only. Without database/auth configuration, protected services report unavailable.

Admin access requires `ADMIN_ORIGIN=http://localhost:3001` in the API's ignored environment file, plus an existing verified account granted the singleton administrator role. Provision that role with `MANDATEPAY_ADMIN_USER_ID=<verified-user-id> pnpm --filter @mandatepay/database admin:bootstrap`, then sign in at the admin URL. Customer signup never grants administrator privileges. See [the admin security setup](docs/implementation/ADMIN_PHASE_1.md).

## AI configuration

Configure these in ignored root `.env` or `apps/api/.env` and restart the API. Root provider keys are loaded only by the API:

```dotenv
OPENAI_API_KEY=<your-server-key>
OPENAI_MODEL=sarvam-105b
OPENAI_BASE_URL=https://api.sarvam.ai/v1
OPENAI_RESPONSE_MODE=json_schema
OPENAI_MAX_OUTPUT_TOKENS=2048
OPENAI_REASONING_EFFORT=null
```

The current provider is Sarvam using the OpenAI-compatible chat-completions interface. The parser uses strict structured output, validates the result independently, retains the original instruction and never activates a mandate or moves money. Missing budget or unsupported provider capabilities produce clarification/unavailable responses, without manufacturing permissions. Other compatible providers may be configured, but their schema/model capabilities must be verified separately. STT/TTS are optional voice features and are not needed for this text workflow.

Do not commit credentials or put them in browser/public environment variables.

## Verification

```sh
pnpm format:check
pnpm check
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

`check` runs lint, TypeScript, unit tests and production builds. Integration tests use actual isolated PostgreSQL. Browser tests start a separate test API on 4100 and production Next.js on 3100, with an HTTP AI fixture on 4200 and an injected simulated PayPal transport. They exercise the actual financial API/database/UI without live keys or payment accounts. Live Sarvam and Sandbox evidence remain separate. Run package-specific database typechecks after its build/generate step; root tasks order this automatically.

## Workspace

| Path                  | Purpose                                                    |
| --------------------- | ---------------------------------------------------------- |
| `apps/web`            | Next.js App Router, React, Tailwind, application UI        |
| `apps/admin`          | Next.js operator console (separate origin and identity)    |
| `apps/api`            | Fastify, Better Auth, protected server routes              |
| `apps/mcp`            | MCP server (stdio and Streamable HTTP) for external agents |
| `packages/shared`     | Strict domain contracts and integer-cent arithmetic        |
| `packages/agent`      | Server-only parsing, ranking, analytics and limited tools  |
| `packages/channel3`   | Normalized discovery and explicit demo merchant catalog    |
| `packages/paypal`     | Sandbox OAuth, orders, captures, refunds and webhooks      |
| `packages/agentguard` | Pure deterministic policy decisions                        |
| `packages/database`   | Prisma migrations, repositories, immutable audit/history   |
| `packages/ui`         | Shared shadcn components, theme and controls               |

Use `pnpm dev:web` / `pnpm dev:api` to start one surface, `pnpm build` for production builds, and package `start` scripts afterward. Optional `pnpm --filter @mandatepay/database seed` creates clearly marked sample records, not provider-confirmed financial evidence.

## Design and licensing

Shared theme tokens preserve warm ivory, sand and dark ink, with Hedvig Letters Serif and Satoshi. Satoshi's binary is excluded from Git; web build/dev downloads it directly from Fontshare for local self-hosting. Other font licenses are included. The generated meadow artwork and approved hero/footer remain local assets. See [third-party notices](THIRD_PARTY_NOTICES.md) and [artwork record](docs/design/hero-artwork.md).

Project source uses the root [MIT license](LICENSE). Provider services and third-party assets retain their own terms.

## Current limits

Production authentication requires HTTPS, `AUTH_SECRET`, PostgreSQL, `RESEND_API_KEY`, and a verified bare-email `AUTH_EMAIL_FROM`. Email verification is required in production; local development/test signup remains immediate by default. Verification/resend, forgot-password and single-use reset flows are implemented. Reset invalidates existing sessions. Tests use a fake sender; live sender delivery remains unverified. See [environment setup](docs/development/environment.md).

Background workers run after building the API: `pnpm --filter @mandatepay/api worker:webhooks` retries previously verified inbox events with leases and bounded backoff, and `pnpm --filter @mandatepay/api worker:reconcile` settles or releases stale captures and replays uncertain saved-PayPal orders with their original request id. Neither creates new payments. Judge/demo accounts can be provisioned with `pnpm --filter @mandatepay/api demo:account` (see [Render setup](docs/deployment/RENDER.md)). See also the [threat model](docs/security/THREAT_MODEL.md), [system diagram](docs/architecture/SYSTEM.md), [commerce API](docs/architecture/commerce-api.md), [Postman collection](docs/api/POSTMAN.md) and [demo runbook](docs/demo/RUNBOOK.md).

PayPal runs in Sandbox by default; `PAYPAL_ENV=live` is an explicit opt-in that has not been qualified. Saved-PayPal autonomy requires Vault to be enabled on the PayPal app and a 32-byte `TOKEN_ENCRYPTION_KEY`; production also requires `MANDATE_SIGNING_KEY` and `INTERNAL_PROXY_SECRET`. Hosted deployment, live email delivery and the final submission video remain open. AG Studio, recurring purchases and voice are not implemented. Exact evidence and boundaries are recorded in [the handoff](docs/implementation/PROGRESS.md).
