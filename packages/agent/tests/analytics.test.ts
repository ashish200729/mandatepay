import { describe, expect, it } from "vitest";
import {
  AnalyticsModelResponseSchema,
  OpenAIOutputError,
  OpenAIProviderError,
  createOpenAIClient,
  parseAnalyticsQuery,
  parseOpenAIConfig,
} from "../src/index.js";

const NOW = "2026-10-02T12:00:00Z";

function readyAnalytics(overrides: Record<string, unknown> = {}) {
  return {
    status: "ready",
    clarification: null,
    minimumAmountDecimal: "100.00",
    minimumAmountOperator: "gt",
    maximumAmountDecimal: null,
    maximumAmountOperator: null,
    decision: null,
    since: null,
    until: null,
    category: null,
    chart: "table",
    ...overrides,
  };
}

function mockClient(output: unknown, status = 200, errorMessage = "provider failure") {
  let requestBody: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    if (typeof init?.body === "string")
      requestBody = JSON.parse(init.body) as Record<string, unknown>;
    const body =
      status >= 400
        ? { error: { message: errorMessage } }
        : {
            id: "analytics-test",
            object: "chat.completion",
            created: 1,
            model: "test-model",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: JSON.stringify(output), refusal: null },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const config = parseOpenAIConfig({
    apiKey: "sk-analytics-test",
    model: "analytics-model",
    baseURL: "https://gateway.example/v1",
    maxRetries: 0,
  });
  return {
    config,
    client: createOpenAIClient(config, { fetch: fetcher }),
    get requestBody() {
      return requestBody;
    },
  };
}

describe("natural-language analytics parser", () => {
  it("preserves exclusive above semantics as a typed amount operator", async () => {
    const transport = mockClient(readyAnalytics());
    const result = await parseAnalyticsQuery(
      { query: "Show purchases above $100", now: NOW },
      { config: transport.config, client: transport.client },
    );

    expect(result).toMatchObject({
      status: "ready",
      filters: {
        minimumAmountMinor: 10_000,
        minimumAmountOperator: "gt",
        maximumAmountMinor: null,
        chart: "table",
      },
    });
    expect(JSON.stringify(transport.requestBody?.messages)).toContain("read-only");
    expect(transport.requestBody?.max_completion_tokens).toBe(2_048);
  });

  it("derives this-week bounds from trusted UTC Monday and keeps blocked as a filter", async () => {
    const transport = mockClient(
      readyAnalytics({
        decision: "BLOCK",
        since: "2020-01-01T00:00:00Z",
        until: "2020-01-02T00:00:00Z",
        chart: "decisions",
      }),
    );
    const result = await parseAnalyticsQuery(
      { query: "Show everything blocked this week", now: NOW },
      { config: transport.config, client: transport.client },
    );

    expect(result).toMatchObject({
      status: "ready",
      filters: {
        decision: "BLOCK",
        since: "2026-09-28T00:00:00.000Z",
        until: NOW,
        chart: "decisions",
      },
    });
  });

  it("supports category charts without exposing data-access or financial tools", async () => {
    const transport = mockClient(
      readyAnalytics({ category: "Office Supplies", chart: "category" }),
    );
    const result = await parseAnalyticsQuery(
      { query: "Chart office spending by category", now: NOW },
      { config: transport.config, client: transport.client },
    );

    expect(result).toMatchObject({
      status: "ready",
      filters: { category: "Office Supplies", chart: "category" },
    });
    expect(transport.requestBody?.tools).toBeUndefined();
    expect(transport.requestBody?.response_format).toBeDefined();
  });

  it("returns clarification for destructive or unknown operations", async () => {
    const transport = mockClient({
      ...readyAnalytics(),
      status: "needs_clarification",
      clarification: "I can only create read-only dashboard filters.",
    });
    const result = await parseAnalyticsQuery(
      { query: "Delete all blocked purchases", now: NOW },
      { config: transport.config, client: transport.client },
    );
    expect(result).toEqual({
      status: "needs_clarification",
      clarification: "I can only create read-only dashboard filters.",
      filters: null,
    });
  });

  it("rejects untrusted decimal forms, incompatible operators, and extra fields", async () => {
    const malformed = mockClient(readyAnalytics({ minimumAmountDecimal: "1e2" }));
    await expect(
      parseAnalyticsQuery(
        { query: "above 100", now: NOW },
        { config: malformed.config, client: malformed.client },
      ),
    ).rejects.toMatchObject({ code: "CANONICAL_VALIDATION_FAILED" });

    const invalidMinimumOperator = mockClient(readyAnalytics({ minimumAmountOperator: "lt" }));
    await expect(
      parseAnalyticsQuery(
        { query: "below 100", now: NOW },
        { config: invalidMinimumOperator.config, client: invalidMinimumOperator.client },
      ),
    ).rejects.toMatchObject({ code: "CANONICAL_VALIDATION_FAILED" });

    const incompatible = mockClient(
      readyAnalytics({
        minimumAmountDecimal: "200",
        minimumAmountOperator: "gte",
        maximumAmountDecimal: "100",
        maximumAmountOperator: "lte",
      }),
    );
    const clarification = await parseAnalyticsQuery(
      { query: "between conflicting amounts", now: NOW },
      { config: incompatible.config, client: incompatible.client },
    );
    expect(clarification.status).toBe("needs_clarification");

    expect(
      AnalyticsModelResponseSchema.safeParse({ ...readyAnalytics(), execute: true }).success,
    ).toBe(false);
  });

  it("redacts provider errors and does not fake a result", async () => {
    const transport = mockClient({}, 503, "raw provider body");
    try {
      await parseAnalyticsQuery(
        { query: "Show purchases", now: NOW },
        { config: transport.config, client: transport.client },
      );
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenAIProviderError);
      expect(String(error)).not.toContain("sk-analytics-test");
      expect(String(error)).not.toContain("raw provider body");
    }
  });

  it("rejects malformed UTC bounds from the model", async () => {
    const transport = mockClient(readyAnalytics({ since: "2026-10-02T00:00:00+05:30" }));
    await expect(
      parseAnalyticsQuery(
        { query: "Show purchases since today", now: NOW },
        { config: transport.config, client: transport.client },
      ),
    ).rejects.toBeInstanceOf(OpenAIOutputError);
  });

  it("fails closed when the caller aborts before the provider call", async () => {
    const transport = mockClient(readyAnalytics());
    await expect(
      parseAnalyticsQuery(
        { query: "Show purchases", now: NOW },
        { config: transport.config, client: transport.client, signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_ABORTED" });
  });
});
