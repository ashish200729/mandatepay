# Foundation and future boundaries

## Implemented now

- `apps/web`: approved landing, auth, mandate lifecycle, discovery/comparison, approvals, Sandbox checkout/order/refund UI, audit timeline and AG Grid Community analytics. Same-origin BFF forwards only allowed routes and cookies to the configured API.
- `apps/admin`: singleton-authorized session/BFF, immutable audit reads, responsive shared admin shell/components, Phase 4 read-only operations pages, Phase 5 user/domain controls and Phase 6 payment/refund/webhook recovery. Platform settings and system health remain later-phase work. See [the UI contract](./admin-ui.md), [the API contract](./admin-api.md), [Phase 5 evidence](../implementation/ADMIN_PHASE_5.md) and [Phase 6 evidence](../implementation/ADMIN_PHASE_6.md). The display-only `ADMIN_ENVIRONMENT` label is safely imported by root configuration; the loopback-test-only fixture flag is excluded.
- `apps/api`: Fastify, Better Auth sessions, owned domain/payment/refund/audit/analytics routes, limited shopping-agent tools, scoped raw webhook verification, rate limits and graceful shutdown.
- `packages/shared`: strict schemas, supported USD currency, branded safe integer minor units and checked arithmetic.
- `packages/agent`: configurable OpenAI-compatible client, independently validated mandate parsing and redacted provider errors; no financial tool access.
- `packages/agentguard`: pure deterministic policy evaluation with hard-block precedence. Financial orchestration is a separate phase.
- `packages/database`: Prisma/PostgreSQL schema, immutable mandate versions/product snapshots/decisions/audits, ownership repositories, accounting and isolated tests.
- `packages/ui`: shared semantic theme and components. It may be imported by frontend applications only.
- `packages/typescript-config`: strict shared compiler settings.
- Root: pnpm/Turborepo, pinned dependencies, Vitest, PostgreSQL integration and Playwright tests, private native database bootstrap and direct-vendor font setup.

`GET /health` is liveness only. `/health/ready` checks configured authentication and database reachability; it does not qualify payments or all providers. Missing auth/database returns 503 for protected services. The frontend talks through its fixed BFF; credentials never enter browser code. See the API contract and phase ledger for implemented operations.

## Remaining workflow modules

| Module               | Responsibility                              |
| -------------------- | ------------------------------------------- |
| `workflows/purchase` | Purchase orchestration and retry boundaries |
| `workflows/refund`   | Refund orchestration and retry boundaries   |

The payment/discovery packages are implemented. Distributed workflow and deployment modules remain pending; do not label local synchronous services as Render Workflows.

## Product review and implementation invariants

The core idea is the mandate, not merely an AI checkout interface. Preserve the separation between semantic product recommendation, deterministic financial permission, and payment execution.

- Monetary values must use integer minor units and explicit currencies; sample dollar strings on the landing page are display content only.
- Never trust LLM-supplied product price, merchant, totals, or authorization. Obtain authoritative data and evaluate it on the backend immediately before payment.
- A global pause must not convert a hard policy violation into an approvable purchase. Evaluate hard block rules first; disable autonomous execution for otherwise eligible proposals.
- Human approval must bind to a specific proposal, price/currency, mandate version, and expiry. A changed proposal needs revalidation and possibly renewed approval.
- Cumulative limits require atomic reservations across concurrent purchases, including reserved and settled spending, with explicit release and reconciliation rules.
- PayPal order creation, capture, and refund need distinct idempotency keys and recoverable state transitions. Retrying a network operation is not permission to execute it twice.
- Webhook signatures must be verified and events deduplicated. Reconcile payment state from verified provider responses and events; do not trust the browser.
- Policy ALLOW does not remove PayPal's own approval requirements. Saved-wallet autonomy depends on provider eligibility and customer consent; retain a standard approval fallback.
- Refunds require authenticated ownership, bounded refundable amounts, and separate permission checks.
- Channel3 discovery is not checkout authority. Any demo merchant mapping must be explicit and truthful.

These are acceptance requirements enforced incrementally. Package presence or local tests do not qualify unimplemented execution/deployment paths. The current boundary and commands are recorded in `docs/implementation/PROGRESS.md`.
