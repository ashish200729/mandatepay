# `@mandatepay/agent`

Server-only mandate parsing for MandatePay. This package interprets a user's request into a reviewable canonical mandate; it does not activate mandates, call tools, search products, authorize spending, or execute payments.

The user's shopping request is authoritative input for drafting a new mandate. Broad categories and brand/model preferences are valid at this stage; exact SKU lookup, reviews, ranking, activation, and payment belong to later boundaries.

## OpenAI boundary

Create configuration from trusted server environment values:

```ts
const config = loadOpenAIConfig();
const result = await parseMandate({ prompt: userText, now: trustedUtcNow }, { config });
```

The parser reads `OPENAI_API_KEY`, `OPENAI_MODEL`, and optional `OPENAI_BASE_URL` only through `loadOpenAIConfig`. The request payload cannot select a provider, model, or base URL. `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`, and custom OpenAI-compatible gateways must be configured explicitly by the trusted server.

`json_schema` is the default response mode and uses the official SDK's `zodResponseFormat` helper. `json_object` is an explicit non-strict-provider mode; its response is parsed and validated with the same schema, and it does not claim schema enforcement by the provider. No model compatibility is inferred from a model name.

The parser bounds generation with `maxOutputTokens` between 128 and 8192, defaulting to 2048. Reasoning is `null` by default to keep this short mandate parse bounded and cost-aware. For the trusted Sarvam V1 base URL `https://api.sarvam.ai/v1`, requests use `max_tokens` and explicitly send `reasoning_effort: null`; other OpenAI-compatible URLs use `max_completion_tokens`, and explicit reasoning values are forwarded only when configured. The model remains required in server configuration, so the parser never silently falls back to an unrequested model.

All structured-output fields are required. Optional budget and date values are represented as `null`. A missing autonomous-spend permission becomes `0` minor units, which means `ALWAYS ASK` downstream. A missing maximum transaction budget returns `needs_clarification`; the parser never raises a budget to fit a product.

The original prompt is returned unchanged as `sourceOriginalPrompt`. Refusals, truncation, malformed output, unsupported response modes, provider failures, and canonical validation failures raise typed errors without exposing API keys, raw provider bodies, or prompt contents.

`rankProducts` accepts a validated canonical mandate and validated Channel3/demo candidates. It returns only `{ recommendations: [{ productId, rank, explanation, tradeoffs }] }`; candidate IDs must be unique and known, and explanations cannot contain prices, totals, permissions, or payment decisions. The ranking step cannot create a proposal or authorize a purchase. The exported search, product-detail, and proposal-input schemas accept only query/product IDs and quantity; price, decision, and owner fields are rejected.

## Bounded shopping runner

`runShoppingAgent` is the server-side tool-calling boundary for shopping conversations. It accepts a message of at most 1,000 characters and a trusted UTC timestamp, then exposes only these injected handlers: `get_active_mandates`, `search_products`, `get_product_details`, `compare_products`, `create_purchase_proposal`, `find_transaction`, and `prepare_refund_request`. There is no payment, capture, refund execution, approval, or `spend_money` tool.

Tool arguments use strict schemas. A purchase proposal accepts only `productId`, `source`, and `quantity`; the server callback computes totals and authorization. A refund tool only prepares `{ paymentID, amountDecimal, reason }` for later human/server handling. Unknown tools, extra fields, malformed amounts, duplicate call IDs, and invalid arguments are rejected before callbacks run. The runner caps the model at five rounds and 768 output tokens per round, bounds handler execution, redacts and size-limits handler results, and returns a `finalAIExplanation` marked `paymentAuthoritative: false`.

## Build and verify

```sh
pnpm --filter @mandatepay/agent build
pnpm --filter @mandatepay/agent typecheck
pnpm --filter @mandatepay/agent lint
pnpm --filter @mandatepay/agent test
```

Tests use mocked fetch responses only. Live model qualification requires the caller to provide server environment configuration separately.
