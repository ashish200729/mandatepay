# MandatePay agent instructions

## Implementation plan

`MandatePay_AgentGuard_End_to_End_Implementation_Plan.md` is now present in the repository root. Its complete 3,375-line contents were reviewed on 2026-10-02, together with the separate 2,702-line product brief at `/Users/ashish/Downloads/file.md`. The root plan is the detailed phase and acceptance reference; the Downloads document is supporting product context.

Read `docs/implementation/PLAN_REVIEW.md` and `docs/implementation/PROGRESS.md` before continuing. The user resolved the backend choice on 2026-10-02: TypeScript and Node.js only, as specified in the plan. Phase-wise implementation is authorized. The AI provider is server-configured with `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL`; do not assume every OpenAI-compatible endpoint supports every model capability.

Before implementing product functionality:

1. Read the complete implementation plan, including its phases, acceptance criteria, and test cases. Expect it in the repository root; if it is elsewhere, locate the exact filename and use that file.
2. Read `PRODUCT.md`, `DESIGN.md`, and `docs/architecture/foundation.md` for the existing product, approved visual system, and architectural boundaries.
3. Inspect the relevant source and current repository state before editing. Preserve unrelated changes.
4. Follow the user's current instructions and the plan within the authorized scope. Surface material conflicts rather than silently changing requirements.

If the plan is missing, do not invent its requirements or claim to have reviewed it. Complete any independent work the user has authorized and state which implementation work needs the missing file. Adding the plan alone does not authorize starting the full implementation.

## Delivery workflow

- Follow the plan phase by phase and respect its dependencies.
- For each authorized phase, implement the behavior, add the relevant test cases, run verification, and review the affected user flow before marking it complete.
- Continue through authorized phases without pausing for routine approval. Ask only when a material requirement or required input is genuinely missing.
- The user now permits concise questions for genuinely required input. Continue independent work while waiting. Secrets belong in ignored local environment files or deployment secret settings, never chat or commits. Do not invent credentials or mark unrun gates complete.
- Keep changes focused, explain decisions plainly, and avoid introducing optional integrations or features outside the requested phase.
- Fix failures caused by the change. Report unrelated failures separately without modifying unrelated work as a shortcut.
- Update the relevant documentation when a phase changes implemented capabilities. Keep planned, implemented, and verified behavior distinct.

## Tests and acceptance evidence

The purpose of the plan and tests is to reduce repeated manual checking by the user. A completed phase must have evidence, not just a statement that it works.

- Implement and run the test cases specified in the plan. Add meaningful regression coverage for additional failure paths uncovered during implementation.
- Test observable behavior and boundaries rather than merely duplicating implementation logic.
- For AgentGuard, cover the three decisions, financial thresholds below/at/above each limit, currency and total validation, product and merchant restrictions, expired or inactive mandates, approval requirements, and global purchasing controls as defined by the plan.
- For database and payment phases, cover concurrent reservations, spending limits, ownership, valid state transitions, retries, idempotency, price changes, webhook verification/deduplication, and refund limits as applicable.
- Use isolated fixtures and sandbox/mocked providers appropriately. Label mocked evidence clearly; never present it as a completed PayPal Sandbox transaction or verified live webhook.
- For UI changes, check desktop and mobile layouts, keyboard focus, navigation, and applicable loading, empty, error, and disabled states.
- Introduce a suitable test runner and package test scripts when functional implementation begins. Do not assume an existing test script is available.
- Run relevant tests and the affected lint, type, build, and formatting checks. Inspect the current root/package scripts before reporting what a command verifies; add real unit/integration/E2E tests as functionality is implemented.
- Do not mark acceptance criteria complete when a required test fails or has not been run. State any external dependency that prevents verification.

## Architecture and financial boundaries

**AI proposes. AgentGuard authorizes. PayPal executes.**

- AgentGuard must be deterministic. An LLM may propose or explain; it cannot override financial permissions or execute unrestricted payments.
- Keep financial operations and provider credentials server-side. Never expose secrets in frontend code, logs, or committed files.
- Use integer minor units and explicit currencies for monetary calculations.
- Revalidate authoritative product data, totals, mandate version/expiry, approvals, spending allowance, and existing payment state immediately before execution.
- Enforce cumulative spending limits with atomic reservations. Preserve idempotency and auditability throughout payment and refund workflows.
- A hard policy violation remains blocked even when autonomous purchasing is disabled or human approval is requested.
- Preserve provider approval/consent requirements. Policy permission does not bypass PayPal requirements.
- Follow the detailed contracts and acceptance criteria in the supplied plan when those modules are implemented.

## Existing foundation and design

The repository uses pnpm/Turborepo, Next.js/React, TypeScript/Fastify, Better Auth, Prisma/PostgreSQL and shared UI/domain packages. Mandate parsing/review/versioning and authentication are implemented. Consult `docs/implementation/PROGRESS.md` for current phase gates; do not infer payment/provider/deployment qualification from package presence. Landing-page examples remain illustrative.

- Preserve the approved landing page, landscape artwork, and clean text navigation unless the user requests a design change.
- Use Tailwind CSS utilities, shared semantic theme tokens, and shadcn/ui components. Maintain the warm ivory/sand palette and Hedvig Letters Serif/Satoshi typography across new application screens.
- Reuse shared button styles and preserve keyboard focus, touch targets, reduced-motion behavior, and mobile menu interactions.
- Use file-editing tools for source changes; use commands for inspection, dependency/runtime setup, and verification.
- Keep work local unless the user authorizes publishing or pushing.

## Completion report

For each completed phase, report the behavior implemented, acceptance criteria satisfied, tests/checks run and their outcomes, and any remaining limitations. Do not claim production, provider, or deployment qualification from local builds or mocked tests alone.
