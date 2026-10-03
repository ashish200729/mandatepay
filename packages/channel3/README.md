# `@mandatepay/channel3`

Server-only Channel3 discovery and deterministic demo catalog contracts.

The client uses Channel3's documented `POST /v1/search` and `POST /v1/lookup` endpoints with the server-only `x-api-key` header. External products are normalized into USD integer minor units and are always marked `checkoutEligible: false`. Missing product ID, title, brand, price, currency, condition, or merchant data fails closed with a typed normalization error.

Canonical search responses use `brands[]`, a category object, `images[]`, and retailer `offers[]`. The adapter reads brand names, category titles, the main image, and the first offer's domain, condition, current price, currency, and URL. It keeps those offer facts together and does not treat the comparison price as the current price. Legacy flat responses remain supported. See the provider's [product](https://docs.trychannel3.com/guides/product) and [offer](https://docs.trychannel3.com/guides/offer) contracts. Product-search logs include only typed failure codes and provider HTTP status, never credentials or raw provider responses.

The demo catalog is a separate, labeled source. Its products are the only products marked checkout eligible, and each carries an explicit `demoSku`. No external Channel3 product is silently mapped to demo checkout.

For live discovery, normalized `metadata.categoryPath` contains labels from the provider's category hierarchy. Chat can match a saved parent category such as Shoes to a Sneakers listing while still excluding blocked parent or child categories. Arbitrary provider metadata cannot supply this reserved hierarchy field. Demo snapshots retain their existing metadata. Chat includes the mandate's required brands in the retrieval query before applying budget and product restrictions; safe server logs record retrieved and matching counts without the query or product payload.

Fallback is disabled by default. Set `CHANNEL3_FALLBACK_MODE=demo` through trusted server configuration to use the local catalog when the API key is absent or discovery fails. The fallback result remains labeled `source: "demo"`; it is never presented as a successful Channel3 response.

Snapshots require a caller-supplied UTC capture timestamp and are deeply frozen so later provider changes cannot mutate the data used by policy evaluation.

## Build and verify

```sh
pnpm --filter @mandatepay/channel3 build
pnpm --filter @mandatepay/channel3 typecheck
pnpm --filter @mandatepay/channel3 lint
pnpm --filter @mandatepay/channel3 test
```
