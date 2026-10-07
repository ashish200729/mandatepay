import { z } from "zod";
import {
  Channel3ConfigurationError,
  Channel3InputError,
  Channel3ProviderError,
  isChannel3Error,
} from "./errors.js";
import { lookupDemoProduct, searchDemoCatalog } from "./demo.js";
import { normalizeProduct, type NormalizedProduct } from "./product.js";
import { parseChannel3Config, type Channel3Config } from "./config.js";

export const Channel3SearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    limit: z.number().int().positive().max(100).default(20),
    filters: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type Channel3SearchRequest = z.output<typeof Channel3SearchRequestSchema>;

export const Channel3LookupRequestSchema = z
  .object({
    url: z.string().url().nullable().default(null),
    productId: z.string().trim().min(1).nullable().default(null),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.url === null) === (request.productId === null)) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "Provide exactly one product URL or product ID.",
      });
    }
  });

export type Channel3LookupRequest = z.output<typeof Channel3LookupRequestSchema>;

export interface Channel3ClientOptions {
  readonly fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function extractRecords(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = record(payload);
  if (!root) throw new Channel3ProviderError("INVALID_RESPONSE");

  for (const key of ["products", "items", "results"]) {
    if (Array.isArray(root[key])) return root[key];
  }

  if (Array.isArray(root.data)) return root.data;
  if (record(root.product)) return [root.product];
  if (record(root.item)) return [root.item];
  if (record(root.data)) return extractRecords(root.data);
  throw new Channel3ProviderError("INVALID_RESPONSE");
}

function statusOf(error: unknown): number | undefined {
  if (!isChannel3Error(error)) return undefined;
  return error instanceof Channel3ProviderError ? error.status : undefined;
}

function isRetryableStatus(status: number | undefined): boolean {
  return (
    status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)
  );
}

function normalizeRequestInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: "INVALID_SEARCH_REQUEST" | "INVALID_LOOKUP_REQUEST",
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Channel3InputError(code);
  return parsed.data;
}

export class Channel3Client {
  readonly config: Channel3Config;
  private readonly fetcher: typeof fetch;

  constructor(configInput: Channel3Config, options: Channel3ClientOptions = {}) {
    this.config = parseChannel3Config(configInput);
    this.fetcher = options.fetch ?? fetch;
  }

  private async post(path: string, body: JsonRecord): Promise<unknown> {
    if (this.config.apiKey === null) {
      throw new Channel3ProviderError("UPSTREAM_REQUEST_FAILED");
    }

    const url = `${this.config.baseURL.replace(/\/+$/u, "")}/${path}`;
    let attempt = 0;

    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await this.fetcher(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.config.apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          throw new Channel3ProviderError(
            retryable ? "UPSTREAM_UNAVAILABLE" : "UPSTREAM_REQUEST_FAILED",
            response.status,
            retryable,
          );
        }

        try {
          return await response.json();
        } catch {
          throw new Channel3ProviderError("INVALID_RESPONSE");
        }
      } catch (error) {
        const mapped =
          error instanceof Channel3ProviderError
            ? error
            : controller.signal.aborted
              ? new Channel3ProviderError("UPSTREAM_TIMEOUT", undefined, true)
              : new Channel3ProviderError("UPSTREAM_REQUEST_FAILED");
        const status = statusOf(mapped);
        if (mapped.retryable && attempt < this.config.maxRetries) {
          attempt += 1;
          continue;
        }
        if (status !== undefined && isRetryableStatus(status) && attempt < this.config.maxRetries) {
          attempt += 1;
          continue;
        }
        throw mapped;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  private fallbackSearch(
    request: Channel3SearchRequest,
    error: unknown,
  ): readonly NormalizedProduct[] {
    if (this.config.fallbackMode !== "demo") throw error;
    return searchDemoCatalog(request.query, request.limit);
  }

  /**
   * Bounded connectivity check. The response body is discarded so a health
   * probe cannot leak catalog payloads or the API key.
   */
  async probeConnectivity(): Promise<void> {
    if (this.config.apiKey === null) {
      throw new Channel3ConfigurationError("MISSING_API_KEY");
    }
    await this.post("search", { query: "health", limit: 1, filters: {} });
  }

  async searchProducts(input: unknown): Promise<readonly NormalizedProduct[]> {
    const request = normalizeRequestInput(
      Channel3SearchRequestSchema,
      input,
      "INVALID_SEARCH_REQUEST",
    );

    if (this.config.apiKey === null && this.config.fallbackMode === "demo") {
      return searchDemoCatalog(request.query, request.limit);
    }

    try {
      const payload = await this.post("search", {
        query: request.query,
        limit: request.limit,
        filters: request.filters,
      });
      return extractRecords(payload).map((product) => normalizeProduct(product));
    } catch (error) {
      return this.fallbackSearch(request, error);
    }
  }

  async lookupProduct(input: unknown): Promise<NormalizedProduct> {
    const request = normalizeRequestInput(
      Channel3LookupRequestSchema,
      input,
      "INVALID_LOOKUP_REQUEST",
    );

    if (this.config.apiKey === null && this.config.fallbackMode === "demo" && request.productId) {
      const demoProduct = lookupDemoProduct(request.productId);
      if (demoProduct) return demoProduct;
    }

    try {
      const payload = await this.post(
        "lookup",
        request.url ? { url: request.url } : { product_id: request.productId },
      );
      const [product] = extractRecords(payload);
      if (product === undefined) throw new Channel3ProviderError("INVALID_RESPONSE");
      return normalizeProduct(product);
    } catch (error) {
      if (this.config.fallbackMode === "demo" && request.productId) {
        const demoProduct = lookupDemoProduct(request.productId);
        if (demoProduct) return demoProduct;
      }
      throw error;
    }
  }
}

export async function searchProducts(
  client: Channel3Client,
  input: unknown,
): Promise<readonly NormalizedProduct[]> {
  return client.searchProducts(input);
}

export async function lookupProduct(
  client: Channel3Client,
  input: unknown,
): Promise<NormalizedProduct> {
  return client.lookupProduct(input);
}
