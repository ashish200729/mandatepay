# `@mandatepay/agentguard`

`@mandatepay/agentguard` is the deterministic policy boundary between a purchase proposal and any payment workflow. It is a pure TypeScript package: it has no database, provider, model, network, or payment imports.

## Evaluation contract

Call `evaluatePurchase(input: unknown)` with a `PolicyContext`. The function validates the untrusted context and fails closed with `BLOCK` and `INVALID_POLICY_INPUT` when the shape is not trusted. A valid context contains:

- a versioned mandate and its runtime status, with the proposal bound to that exact version;
- a server-computed proposal;
- an immutable product snapshot with authoritative unit price, currency, merchant, condition, and quantity;
- confirmed spend, active reservations for other proposals, and UTC daily/weekly/monthly periods;
- the evaluation time in UTC and the user-level autonomy setting.

The database layer must provide only active reservations for other proposals. It owns the atomic reservation transaction; AgentGuard only evaluates the supplied snapshot deterministically.

Hard policy violations are collected first and always return `BLOCK`. Approval signals such as global autonomy being disabled, exceeding the automatic-spend threshold, or a new merchant are considered only after every hard rule passes. Otherwise the result is `ALLOW`.

The exported reason-code set includes the shared mandate rules plus explicit fail-closed contract failures such as `PRODUCT_DATA_UNTRUSTED`, `PROPOSAL_TOTAL_MISMATCH`, `CURRENCY_MISMATCH`, and `SPEND_CONTEXT_INVALID`.

## Build and verify

```sh
pnpm --filter @mandatepay/agentguard build
pnpm --filter @mandatepay/agentguard typecheck
pnpm --filter @mandatepay/agentguard lint
pnpm --filter @mandatepay/agentguard test
```

The package emits NodeNext ESM JavaScript and declaration files under `dist/`.
