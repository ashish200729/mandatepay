import { createServer } from "node:http";

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
      if (input.model !== "mandate-e2e-fixture" || input.response_format?.type !== "json_schema") {
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
      if (input.response_format.json_schema?.name === "product_ranking") {
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
      response.end(
        JSON.stringify({
          id: "e2e-mandate-completion",
          object: "chat.completion",
          created: Math.floor(now.getTime() / 1000),
          model: input.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: JSON.stringify(output) },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
        }),
      );
    } catch {
      response.writeHead(400).end(JSON.stringify({ error: "Invalid test provider request" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(4200, "127.0.0.1", resolve);
  });
  return server;
}
