# `@mandatepay/shared`

Server-safe contracts shared by MandatePay services. This package contains no provider, model, database, or payment implementation.

## Contracts

- `CanonicalMandateSchema` / `CanonicalMandate`: the reviewed mandate definition. It is USD-only for the MVP, requires UTC timestamps, requires explicit allowed conditions and new-merchant approval behavior, and rejects unknown fields or contradictory allow/block lists.
- `PurchaseProposalSchema`: proposal data with integer minor-unit amounts. The supplied total must equal subtotal plus shipping plus tax using checked integer arithmetic.
- `RefundRequestSchema`: authenticated payment reference, positive amount, currency, reason, and full/partial kind.
- `PolicyDecisionSchema`: `ALLOW`, `REQUIRE_APPROVAL`, or `BLOCK` with stable reason codes.
- `MandateStatusSchema`, `ProposalStatusSchema`, and `RefundStatusSchema`: persisted state values with frozen transition maps and `transition*` helpers.

## Money rules

`MinorUnits` is a branded, non-negative safe integer. Use `parseDecimalToMinorUnits` for user-facing decimal strings and `formatMinorUnits` for display. Numeric strings, floating-point values, negative values, unsafe integers, scientific notation, and more than two USD fraction digits are rejected.

The package currently supports only `USD`. Add a currency only when its minor-unit rules, validation, display, and policy behavior are specified together.

## Build and verify

```sh
pnpm --filter @mandatepay/shared build
pnpm --filter @mandatepay/shared typecheck
pnpm --filter @mandatepay/shared lint
pnpm --filter @mandatepay/shared test
```

The workspace must be installed before the Vitest command can run. The package emits NodeNext ESM JavaScript and declaration files under `dist/`.
