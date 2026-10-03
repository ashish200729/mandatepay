export {
  DEFAULT_CHANNEL3_BASE_URL,
  Channel3ConfigSchema,
  Channel3FallbackModeSchema,
  loadChannel3Config,
  parseChannel3Config,
  type Channel3Config,
  type Channel3FallbackMode,
} from "./config.js";
export {
  Channel3ConfigurationError,
  Channel3Error,
  Channel3InputError,
  Channel3NormalizationError,
  Channel3ProviderError,
  isChannel3Error,
  type Channel3ConfigurationErrorCode,
  type Channel3ErrorCode,
  type Channel3InputErrorCode,
  type Channel3NormalizationErrorCode,
  type Channel3ProviderErrorCode,
} from "./errors.js";
export {
  Channel3LookupRequestSchema,
  Channel3SearchRequestSchema,
  Channel3Client,
  lookupProduct,
  searchProducts,
  type Channel3ClientOptions,
  type Channel3LookupRequest,
  type Channel3SearchRequest,
} from "./client.js";
export { DEMO_CATALOG, demoPrice, lookupDemoProduct, searchDemoCatalog } from "./demo.js";
export {
  NormalizedProductSchema,
  ProductSnapshotSchema,
  normalizeProduct,
  snapshotProduct,
  type NormalizedProduct,
  type NormalizeProductOptions,
  type ProductSnapshot,
} from "./product.js";
