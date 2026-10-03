import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAIProviderError,
  createOpenAIClient,
  parseOpenAIConfig,
  runShoppingAgent,
} from "../src/index.js";

const NOW = "2026-10-02T12:00:00Z";

function finalResponse(
  content = "I found a suitable option. The server still controls authorization.",
) {
  return {
    id: "shopping-final",
    object: "chat.completion",
    created: 1,
    model: "shopping-model",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content, refusal: null },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function toolResponse(name: string, args: unknown, id = "call_1", content: string | null = null) {
  return {
    id: `shopping-${id}`,
    object: "chat.completion",
    created: 1,
    model: "shopping-model",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content,
          refusal: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function mockClient(
  responses: readonly unknown[],
  status = 200,
  errorMessage = "provider failure",
) {
  let index = 0;
  const requestBodies: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    if (typeof init?.body === "string") {
      requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    const body = status >= 400 ? { error: { message: errorMessage } } : responses[index++];
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const config = parseOpenAIConfig({
    apiKey: "sk-shopping-test",
    model: "shopping-model",
    baseURL: "https://gateway.example/v1",
    maxRetries: 0,
  });
  return {
    config,
    client: createOpenAIClient(config, { fetch: fetcher }),
    requestBodies,
  };
}

const baseInput = { message: "Find my usual headphones and prepare the best option.", now: NOW };

describe("bounded shopping agent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reads the selected mandate before searching an ambiguous user message", async () => {
    const transport = mockClient([
      toolResponse("get_active_mandates", {}, "mandate-context"),
      toolResponse(
        "search_products",
        { query: "Nike shoes", maximumPriceMinor: 10_000, brands: ["Nike"], category: null },
        "nike-search",
      ),
      finalResponse("Nike shoes are available within your budget."),
    ]);
    const getMandates = vi.fn(async () => ({
      mandates: [
        {
          rules: { productIntent: "Nike shoes", transactionLimit: 10_000, autoSpendLimit: 0 },
          budget: { maximumTotal: "$100.00 USD", approval: "Ask before every purchase" },
        },
      ],
    }));
    const search = vi.fn(async () => ({ products: [] }));
    const result = await runShoppingAgent(
      { message: "check the products related to this", now: NOW },
      { ...transport, tools: { get_active_mandates: getMandates, search_products: search } },
    );
    expect(transport.requestBodies[0]?.tool_choice).toEqual({
      type: "function",
      function: { name: "get_active_mandates" },
    });
    expect(transport.requestBodies[1]?.tool_choice).toBe("auto");
    expect(transport.requestBodies[1]?.messages).toContainEqual(
      expect.objectContaining({ role: "tool", content: expect.stringContaining("Nike shoes") }),
    );
    const context = (
      transport.requestBodies[1]?.messages as { role: string; content: string }[]
    ).find((message) => message.role === "tool");
    expect(JSON.parse(context!.content)).toMatchObject({
      mandates: [
        {
          rules: { transactionLimit: 10_000, autoSpendLimit: 0 },
          budget: { maximumTotal: "$100.00 USD" },
        },
      ],
    });
    expect(result.trace.map((entry) => entry.name)).toEqual([
      "get_active_mandates",
      "search_products",
    ]);
    expect(getMandates.mock.invocationCallOrder[0]).toBeLessThan(
      search.mock.invocationCallOrder[0]!,
    );
  });

  it("works with a provider that rejects unsupported strict-schema keywords", async () => {
    const transport = mockClient([]);
    const client = createOpenAIClient(transport.config, {
      fetch: async (_url, init) => {
        const unsupported = String(init?.body).includes('"uniqueItems"');
        return Response.json(
          unsupported ? { error: { message: "uniqueItems is not permitted" } } : finalResponse(),
          { status: unsupported ? 400 : 200 },
        );
      },
    });
    await expect(
      runShoppingAgent(baseInput, { config: transport.config, client, tools: {} }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("still rejects duplicate comparison IDs before running the comparison tool", async () => {
    const transport = mockClient([
      toolResponse("compare_products", { productIds: ["product_1", "product_1"] }),
    ]);
    const compare = vi.fn();
    await expect(
      runShoppingAgent(baseInput, { ...transport, tools: { compare_products: compare } }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_ARGUMENTS" });
    expect(compare).not.toHaveBeenCalled();
  });

  it.each(["gpt-6-luna", "gpt-6-luna-test-snapshot"])(
    "uses the required Chat Completions tool mode for %s",
    async (model) => {
      const config = parseOpenAIConfig({
        apiKey: "unit-test-key",
        model,
        baseURL: "https://api.openai.com/v1",
        reasoningEffort: null,
      });
      const client = createOpenAIClient(config, {
        fetch: async (_url, init) => {
          const request = JSON.parse(String(init?.body));
          return Response.json(
            request.reasoning_effort === "none"
              ? finalResponse()
              : { error: { message: "Function tools require reasoning_effort none" } },
            { status: request.reasoning_effort === "none" ? 200 : 400 },
          );
        },
      });
      await expect(
        runShoppingAgent(baseInput, { config, client, tools: {} }),
      ).resolves.toMatchObject({ status: "completed" });
    },
  );

  it("bounds the whole workflow across multiple model rounds and stops subsequent tools", async () => {
    vi.useFakeTimers();
    const transport = mockClient([]);
    let round = 0;
    vi.spyOn(transport.client.chat.completions, "create").mockImplementation((_body, options) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(toolResponse("get_active_mandates", {}, `call_${++round}`)),
          35_000,
        );
        options?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      }) as ReturnType<typeof transport.client.chat.completions.create>;
    });
    const handler = vi.fn(async () => ({ mandates: [] }));
    const result = expect(
      runShoppingAgent(baseInput, { ...transport, tools: { get_active_mandates: handler } }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
    expect(handler).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([[], null])(
    "accepts a provider's empty tool_calls value on a final stop response",
    async (toolCalls) => {
      const response = finalResponse();
      Object.assign(response.choices[0]!.message, { tool_calls: toolCalls });
      const transport = mockClient([response]);
      const result = await runShoppingAgent(baseInput, { ...transport, tools: {} });
      expect(result.status).toBe("completed");
      expect(result.trace).toEqual([]);
    },
  );
  it("executes only injected allow-listed tools and returns a non-authoritative explanation", async () => {
    const transport = mockClient([
      toolResponse("search_products", {
        query: "noise cancelling headphones",
        maximumPriceMinor: 18_000,
        brands: ["Sony"],
        category: "Headphones",
      }),
      toolResponse(
        "create_purchase_proposal",
        {
          productId: "demo-headphones-169",
          source: "demo",
          quantity: 1,
        },
        "call_2",
      ),
      finalResponse(
        "The server prepared the proposal; AgentGuard and the payment service remain authoritative.",
      ),
    ]);
    const seen: string[] = [];

    const result = await runShoppingAgent(baseInput, {
      config: transport.config,
      client: transport.client,
      tools: {
        search_products: async (input) => {
          seen.push(`search:${input.query}`);
          return {
            products: [{ id: "demo-headphones-169", title: "Sony headphones" }],
            token: "provider-secret",
            nested: { apiKey: "hidden" },
          };
        },
        create_purchase_proposal: async (input) => {
          seen.push(`proposal:${input.productId}:${input.source}:${input.quantity}`);
          return { proposalId: "proposal-1", totalMinor: 16_900 };
        },
      },
    });

    expect(seen).toEqual([
      "search:noise cancelling headphones",
      "proposal:demo-headphones-169:demo:1",
    ]);
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(3);
    expect(result.trace.map((entry) => entry.name)).toEqual([
      "search_products",
      "create_purchase_proposal",
    ]);
    expect(result.trace[0]?.result).toMatchObject({
      token: "[redacted]",
      nested: { apiKey: "[redacted]" },
    });
    expect(result.finalAIExplanation).toMatchObject({
      kind: "explanation",
      paymentAuthoritative: false,
    });
    expect(result.finalAIExplanation.text).toContain("authoritative");

    const firstRequest = transport.requestBodies[0];
    expect(firstRequest?.max_completion_tokens).toBe(768);
    const tools = firstRequest?.tools as Array<{ function?: { name?: string } }>;
    expect(tools.map((tool) => tool.function?.name)).toEqual([
      "get_active_mandates",
      "search_products",
      "get_product_details",
      "compare_products",
      "create_purchase_proposal",
      "find_transaction",
      "prepare_refund_request",
    ]);
    expect(tools.map((tool) => tool.function?.name)).not.toContain("spend_money");
  });

  it("rejects a model-invented finance tool without invoking any handler", async () => {
    const transport = mockClient([toolResponse("spend_money", { amount: 500 })]);
    let called = false;

    await expect(
      runShoppingAgent(baseInput, {
        config: transport.config,
        client: transport.client,
        tools: {
          search_products: async () => {
            called = true;
            return {};
          },
        },
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_TOOL" });
    expect(called).toBe(false);
  });

  it("rejects proposal totals, owners, and malformed refund amounts before callbacks", async () => {
    const invalidCalls = [
      toolResponse("create_purchase_proposal", {
        productId: "demo-headphones-169",
        source: "demo",
        quantity: 1,
        totalMinor: 16_900,
        ownerId: "other-user",
      }),
      toolResponse("prepare_refund_request", {
        paymentID: "payment-1",
        amountDecimal: "1e2",
        reason: "damaged",
      }),
    ];

    for (const response of invalidCalls) {
      const transport = mockClient([response]);
      let called = false;
      await expect(
        runShoppingAgent(baseInput, {
          config: transport.config,
          client: transport.client,
          tools: {
            create_purchase_proposal: async () => {
              called = true;
              return {};
            },
            prepare_refund_request: async () => {
              called = true;
              return {};
            },
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_TOOL_ARGUMENTS" });
      expect(called).toBe(false);
    }
  });

  it("bounds tool rounds and handler duration", async () => {
    const repeated = Array.from({ length: 5 }, (_, index) =>
      toolResponse("get_active_mandates", {}, `call_${index + 1}`),
    );
    const transport = mockClient(repeated);
    let calls = 0;
    await expect(
      runShoppingAgent(baseInput, {
        config: transport.config,
        client: transport.client,
        tools: {
          get_active_mandates: async () => {
            calls += 1;
            return { mandates: [] };
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TOOL_ROUND_LIMIT" });
    expect(calls).toBe(4);

    const timeoutTransport = mockClient([toolResponse("get_active_mandates", {})]);
    await expect(
      runShoppingAgent(baseInput, {
        config: timeoutTransport.config,
        client: timeoutTransport.client,
        toolTimeoutMs: 5,
        tools: { get_active_mandates: async () => new Promise(() => undefined) },
      }),
    ).rejects.toMatchObject({ code: "TOOL_TIMEOUT" });
  });

  it("redacts handler failures and provider bodies", async () => {
    const handlerTransport = mockClient([toolResponse("get_active_mandates", {})]);
    await expect(
      runShoppingAgent(baseInput, {
        config: handlerTransport.config,
        client: handlerTransport.client,
        tools: {
          get_active_mandates: () => {
            throw new Error("secret provider body");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TOOL_HANDLER_FAILED" });

    const providerTransport = mockClient([], 503, "raw provider body sk-shopping-test");
    try {
      await runShoppingAgent(baseInput, {
        config: providerTransport.config,
        client: providerTransport.client,
        tools: {},
      });
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenAIProviderError);
      expect(String(error)).not.toContain("raw provider body");
      expect(String(error)).not.toContain("sk-shopping-test");
    }
  });
});
