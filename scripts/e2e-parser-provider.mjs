import { createServer } from "node:http";

const shoppingToolNames = [
  "get_active_mandates",
  "search_products",
  "get_product_details",
  "compare_products",
  "create_purchase_proposal",
  "find_transaction",
  "prepare_refund_request",
];

function toolCall(name, arguments_) {
  return {
    id: `e2e-${name}`,
    type: "function",
    function: { name, arguments: JSON.stringify(arguments_) },
  };
}

function toolResult(input, name) {
  const message = input.messages.findLast(
    (message) => message.role === "tool" && message.tool_call_id === `e2e-${name}`,
  );
  return message ? JSON.parse(message.content) : null;
}

function shoppingMessage(input) {
  const initialMandateChoice =
    input.tool_choice?.type === "function" &&
    input.tool_choice.function?.name === "get_active_mandates";
  if (
    input.response_format !== undefined ||
    (input.tool_choice !== "auto" && !initialMandateChoice) ||
    input.tools.length !== shoppingToolNames.length ||
    input.tools.some(
      (tool, index) =>
        tool.type !== "function" ||
        tool.function?.name !== shoppingToolNames[index] ||
        tool.function.parameters?.additionalProperties !== false,
    )
  )
    throw new Error("Unexpected shopping fixture contract");
  const prompt = input.messages.find((message) => message.role === "user")?.content;
  if (typeof prompt !== "string") throw new Error("Missing shopping fixture prompt");
  const call = (name, arguments_) => ({
    role: "assistant",
    content: null,
    tool_calls: [toolCall(name, arguments_)],
  });
  // Match the actual runner's required first tool, including refund sessions
  // with no active mandate. Later rounds remain in automatic tool mode.
  if (initialMandateChoice) return call("get_active_mandates", {});
  const refund =
    /^Prepare a \$20 partial refund for transaction ([a-z0-9-]+) because One item was damaged\.$/u.exec(
      prompt,
    );
  if (refund) {
    const found = toolResult(input, "find_transaction");
    if (!found) return call("find_transaction", { transactionId: refund[1], query: null });
    if (!found.transactions?.some((transaction) => transaction.id === refund[1]))
      throw new Error("Missing owned refund fixture transaction");
    if (!toolResult(input, "prepare_refund_request"))
      return call("prepare_refund_request", {
        paymentID: refund[1],
        amountDecimal: "20.00",
        reason: "One item was damaged.",
      });
    return {
      role: "assistant",
      content: "A $20 refund draft is ready for your review. No refund has been executed.",
    };
  }
  const selection = {
    "Compare Sony headphones and prepare the $169 new pair for review.": "demo-headphones-169",
    "Prepare the refurbished Bose headphones for review.": "demo-headphones-refurbished",
  }[prompt];
  if (!selection) throw new Error("Unknown shopping fixture scenario");
  if (!toolResult(input, "get_active_mandates")) return call("get_active_mandates", {});
  const search = toolResult(input, "search_products");
  if (!search)
    return call("search_products", {
      query: "headphones",
      maximumPriceMinor: 18000,
      brands: ["Sony", "Bose"],
      category: "Headphones",
    });
  if (!search.products?.some((product) => product.externalId === selection)) {
    // The NEW-only mandate excludes this controlled refurbished SKU before
    // proposal creation. Keep that boundary intact in the synthetic model.
    if (selection === "demo-headphones-refurbished")
      return {
        role: "assistant",
        content: "The requested refurbished product is unavailable under this mandate.",
      };
    throw new Error("Missing trusted shopping fixture product");
  }
  if (!toolResult(input, "compare_products"))
    return call("compare_products", {
      productIds: search.products.map((product) => product.externalId),
    });
  if (!toolResult(input, "create_purchase_proposal"))
    return call("create_purchase_proposal", {
      productId: selection,
      source: "demo",
      quantity: 1,
    });
  // Deliberately untrusted wording: browser tests must show the genuine server policy result.
  return {
    role: "assistant",
    content:
      "The model suggests this product is allowed. Review the authoritative server proposal before paying.",
  };
}

function analyticsOutput(input) {
  const prompt = input.messages.findLast((message) => message.role === "user")?.content;
  const scenarios = {
    "Show headphone transactions above $150 as a table.": {
      minimumAmountDecimal: "150.00",
      minimumAmountOperator: "gt",
      category: "Headphones",
      chart: "table",
    },
    "Show blocked headphone transactions this week by decision.": {
      decision: "BLOCK",
      category: "Headphones",
      chart: "decisions",
    },
    "Show headphone spending by category.": { category: "Headphones", chart: "category" },
    "Delete all transactions.": {
      status: "needs_clarification",
      clarification: "Please ask a read-only question about your transactions.",
    },
  };
  if (!Object.hasOwn(scenarios, prompt)) throw new Error("Unknown analytics fixture scenario");
  return {
    status: "ready",
    clarification: null,
    minimumAmountDecimal: null,
    minimumAmountOperator: null,
    maximumAmountDecimal: null,
    maximumAmountOperator: null,
    decision: null,
    since: null,
    until: null,
    category: null,
    chart: "table",
    ...scenarios[prompt],
  };
}

/** Isolated browser-test provider. Never imported by application code. */
export async function startE2eParserProvider() {
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (
      request.method !== "POST" ||
      request.url !== "/v1/chat/completions" ||
      request.headers.authorization !== "Bearer e2e-only-provider-key"
    ) {
      response.writeHead(404).end(JSON.stringify({ error: "Unknown test endpoint" }));
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 64_000) throw new Error("Test request too large");
      }
      const input = JSON.parse(body);
      if (
        input.model !== "mandate-e2e-fixture" ||
        !Array.isArray(input.messages) ||
        input.messages[0]?.role !== "system" ||
        input.messages[1]?.role !== "user" ||
        (!Array.isArray(input.tools) &&
          (input.response_format?.type !== "json_schema" ||
            input.response_format.json_schema?.strict !== true ||
            !["mandate_parse", "product_ranking", "analytics_query"].includes(
              input.response_format.json_schema?.name,
            )))
      ) {
        throw new Error("Unexpected test provider contract");
      }
      const now = new Date();
      let output = {
        status: "ready",
        clarification: null,
        title: "Noise-cancelling headphones",
        productIntent: "noise-cancelling headphones",
        currency: "USD",
        timezone: "UTC",
        allowedBrands: ["Sony", "Bose"],
        blockedBrands: [],
        allowedCategories: ["headphones"],
        blockedCategories: [],
        allowedConditions: ["NEW"],
        transactionLimitDecimal: "180.00",
        autoSpendLimitDecimal: "150.00",
        dailyLimitDecimal: null,
        weeklyLimitDecimal: null,
        monthlyLimitDecimal: null,
        quantityLimit: 1,
        allowedMerchants: [],
        blockedMerchants: [],
        newMerchantRequiresApproval: true,
        startsAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      };
      if (input.response_format?.json_schema?.name === "analytics_query") {
        output = analyticsOutput(input);
      } else if (input.response_format?.json_schema?.name === "product_ranking") {
        const content =
          input.messages.findLast((message) => message.role === "user")?.content ?? "";
        const ids = [
          ...new Set([...content.matchAll(/"productId":"([^"]+)"/g)].map((match) => match[1])),
        ].slice(0, 3);
        if (!ids.length) throw new Error("Missing ranking fixture candidates");
        output = {
          recommendations: ids.map((productId, index) => ({
            productId,
            rank: index + 1,
            explanation: "Matches the selected brand and product category.",
            tradeoffs: [],
          })),
        };
      }
      const message = Array.isArray(input.tools)
        ? shoppingMessage(input)
        : { role: "assistant", content: JSON.stringify(output) };
      response.end(
        JSON.stringify({
          id: "e2e-mandate-completion",
          object: "chat.completion",
          created: Math.floor(now.getTime() / 1000),
          model: input.model,
          choices: [
            {
              index: 0,
              finish_reason: message.tool_calls ? "tool_calls" : "stop",
              message,
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
        }),
      );
    } catch (error) {
      const known = [
        "Unexpected shopping fixture contract",
        "Unexpected test provider contract",
        "Unknown shopping fixture scenario",
        "Missing trusted shopping fixture product",
        "Missing owned refund fixture transaction",
      ];
      console.warn(
        JSON.stringify({
          event: "e2e_provider_request_rejected",
          reason: known.includes(error?.message) ? error.message : "INVALID_TEST_REQUEST",
        }),
      );
      response.writeHead(400).end(JSON.stringify({ error: "Invalid test provider request" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(4200, "127.0.0.1", resolve);
  });
  return server;
}
