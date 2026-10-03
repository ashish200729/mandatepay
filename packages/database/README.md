# MandatePay database

This package owns PostgreSQL persistence for MandatePay's authorization and
financial state. It uses Prisma ORM 7.10.0 with the \`@prisma/adapter-pg\`
driver and a generated ESM client under \`src/generated/prisma\`.

All MVP monetary values are non-negative \`BIGINT\` minor units in \`USD\`. The
repository layer validates the same rules as the migration checks, recomputes
proposal totals from immutable product snapshots, and binds proposals,
approvals, reservations, decisions, payments, and refunds to the owning user.

## Local commands

Create an ignored \`packages/database/.env\` with \`DATABASE_URL\`. Use a separate
\`TEST_DATABASE_URL\` for integration tests when possible.

\`\`\`bash
pnpm generate
pnpm migrate:deploy
pnpm seed
pnpm test
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm format:check
\`\`\`

\`seed\` is idempotent and marks all illustrative financial records with
\`isSample=true\`; it never calls PayPal and does not claim a provider payment,
refund, or webhook occurred.

## Persistence boundaries

- \`MandateRepository\` creates immutable mandate versions and enforces
  owner-scoped status transitions.
- \`ProposalRepository\` recomputes subtotal and total from a product snapshot,
  persists immutable policy history, and binds approval fingerprints.
- \`SpendRepository\` locks the mandate row before checking settled spend and
  active reservations, so concurrent reservations cannot overspend a limit.
- \`PaymentRepository\` persists provider identifiers and idempotent refund
  requests without pretending to execute provider operations.
- \`AuditRepository\` only appends and reads audit events.
- \`WebhookInboxRepository\` deduplicates provider event identity before a later
  webhook processor applies side effects.

The schema reserves Better Auth-compatible \`Session\`, \`Account\`, and
\`Verification\` tables plus user ownership and global-autonomy fields for the
authentication phase.
