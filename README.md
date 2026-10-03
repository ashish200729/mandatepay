# MandatePay

AI commerce with human-controlled spending permissions.

**AI proposes. AgentGuard authorizes. PayPal executes.**

This TypeScript monorepo implements authentication, reviewable/versioned mandates, product discovery and comparison, deterministic AgentGuard decisions, approvals, Sandbox checkout/capture/refund services, verified webhook processing, audit history and an AG Grid Community Control Center. The approved landing page remains intact. Local automated financial tests use an isolated simulated provider; real Sandbox buyer/capture/refund/webhook and hosted deployment qualification remain open. No landing-page example is a real purchase.

Read [phase progress](docs/implementation/PROGRESS.md), [plan review](docs/implementation/PLAN_REVIEW.md), and [tool usage](docs/implementation/TOOL_USAGE.md) for qualification boundaries.

## Local setup

Use Node.js 24 (see `.nvmrc`) and pnpm 10.34.6:

```sh
npm install --global pnpm@10.34.6
pnpm install --frozen-lockfile
```

For the automatic local database setup, install PostgreSQL 17 and make `initdb`, `pg_ctl`, `psql`, and `createdb` available on PATH. On macOS with Homebrew:

```sh
brew install postgresql@17
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
pnpm db:local:start
pnpm --filter @mandatepay/database migrate:deploy
pnpm dev
```

The database helper creates an isolated loopback cluster under ignored `.local/postgres`, listening on port 55432. It creates separate development and test databases, generates private credentials and an authentication secret, and fills ignored environment files without replacing existing nonempty values. It does not modify an existing system PostgreSQL instance. Stop this cluster with `pnpm db:local:stop`.

Alternatively, supply separate PostgreSQL URLs in `packages/database/.env` and `apps/api/.env` using their example files. `TEST_DATABASE_URL` must name a dedicated database ending in `_test`; tests reject a shared development/production database. Set `AUTH_SECRET` to a cryptographically random secret and use matching `APP_URL` / `API_URL`.

- Web: http://localhost:3000
- API liveness: http://localhost:4000/health
- Database/auth readiness: http://localhost:4000/health/ready

Sign up at `/signup`, open **Mandates → New mandate**, review the AI-generated rules, save the draft, then activate it explicitly. `/chat` offers discovery/comparison under the active mandate; prepare a proposal, review required approval, then continue to Sandbox checkout. Use a separate personal Sandbox buyer for PayPal approval. `/orders` shows server-confirmed payment/refund facts; `/dashboard` shows owned analytics. Without database/auth configuration, protected services report unavailable. The limited tool-calling API exists at `/api/agent/chat`; its complete conversational frontend is follow-up work.

## AI configuration

Configure these **only** in ignored `apps/api/.env` and restart the API:

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

| Path                  | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `apps/web`            | Next.js App Router, React, Tailwind, application UI      |
| `apps/api`            | Fastify, Better Auth, protected server routes            |
| `packages/shared`     | Strict domain contracts and integer-cent arithmetic      |
| `packages/agent`      | Server-only provider configuration and mandate parser    |
| `packages/agentguard` | Pure deterministic policy decisions                      |
| `packages/database`   | Prisma migrations, repositories, immutable audit/history |
| `packages/ui`         | Shared shadcn components, theme and controls             |

Use `pnpm dev:web` / `pnpm dev:api` to start one surface, `pnpm build` for production builds, and package `start` scripts afterward. Optional `pnpm --filter @mandatepay/database seed` creates clearly marked sample records, not provider-confirmed financial evidence.

## Design and licensing

Shared theme tokens preserve warm ivory, sand and dark ink, with Hedvig Letters Serif and Satoshi. Satoshi's binary is excluded from Git; web build/dev downloads it directly from Fontshare for local self-hosting. Other font licenses are included. The generated meadow artwork and approved hero/footer remain local assets. See [third-party notices](THIRD_PARTY_NOTICES.md) and [artwork record](docs/design/hero-artwork.md).

Project source uses the root [MIT license](LICENSE). Provider services and third-party assets retain their own terms.

## Current limits

Authentication is currently a sandbox-oriented email/password implementation without verification email or password-reset delivery. Production hosting requires those account-recovery controls, provider configuration, security qualification and hosted acceptance gates. PayPal is sandbox-only when its execution phase is implemented. This repository is an implementation in progress, not a completed commerce demo or production-qualified release.
