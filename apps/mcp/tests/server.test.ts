import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MandatePayApiError, type MandatePayClient } from "../src/api-client.js";
import { createMandatePayMcpServer } from "../src/server.js";
import { mandate, proposal, searchResult } from "./fixtures.js";

function mockClient(overrides: Partial<MandatePayClient> = {}): MandatePayClient {
  return {
    listMandates: vi.fn().mockResolvedValue({ mandates: [mandate] }),
    getMandate: vi.fn().mockResolvedValue({ mandate }),
    searchProducts: vi.fn().mockResolvedValue(searchResult),
    simulatePurchase: vi.fn(),
    proposePurchase: vi.fn().mockResolvedValue(proposal),
    getProposal: vi.fn(),
    getOrderStatus: vi.fn(),
    ...overrides,
  } as MandatePayClient;
}

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

async function connect(client: MandatePayClient) {
  const server = createMandatePayMcpServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  open.push(mcp, server);
  return mcp;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((entry) => entry.text ?? "").join("\n");
}

describe("MandatePay MCP server", () => {
  it("registers exactly the seven agent tools with safety annotations", async () => {
    const mcp = await connect(mockClient());
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_mandate",
      "get_order_status",
      "get_proposal",
      "list_mandates",
      "propose_purchase",
      "search_products",
      "simulate_purchase",
    ]);
    for (const tool of tools) {
      if (tool.name === "propose_purchase") {
        expect(tool.annotations).toMatchObject({ destructiveHint: false, openWorldHint: true });
        expect(tool.annotations?.readOnlyHint).not.toBe(true);
      } else {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
    }
    const propose = tools.find((tool) => tool.name === "propose_purchase")!;
    expect(propose.description).toMatch(/AgentGuard/u);
    expect(propose.description).toMatch(/cannot approve/u);
    const search = tools.find((tool) => tool.name === "search_products")!;
    expect(search.description).toMatch(/untrusted_listing/u);
    expect(JSON.stringify(tools)).not.toMatch(/"(?:approve|refund|capture|checkout)_/u);
    expect(mcp.getInstructions()).toMatch(/cannot approve, pay/u);
  });

  it("returns concise text and structured content", async () => {
    const client = mockClient();
    const mcp = await connect(client);
    const listed = await mcp.callTool({ name: "list_mandates", arguments: {} });
    expect(text(listed)).toContain("Headphones (id mandate-1)");
    expect(listed.structuredContent).toEqual({ mandates: [mandate] });

    const searched = await mcp.callTool({
      name: "search_products",
      arguments: { mandateId: "mandate-1", query: "sony" },
    });
    expect(client.searchProducts).toHaveBeenCalledWith({ mandateId: "mandate-1", query: "sony" });
    expect(text(searched)).toContain("productId demo-headphones-139");
    expect(text(searched)).toContain("listing tried to instruct AI agents");

    const proposed = await mcp.callTool({
      name: "propose_purchase",
      arguments: { mandateId: "mandate-1", productId: "demo-headphones-139", source: "demo" },
    });
    expect(client.proposePurchase).toHaveBeenCalledWith({
      mandateId: "mandate-1",
      productId: "demo-headphones-139",
      source: "demo",
      quantity: 1,
    });
    expect(text(proposed)).toContain("AgentGuard decision: ALLOW");
    expect(text(proposed)).toContain("http://localhost:3000/orders/new?proposalId=proposal-1");
    expect(proposed.isError).toBeFalsy();
  });

  it("rejects invalid arguments before calling MandatePay", async () => {
    const client = mockClient();
    const mcp = await connect(client);
    const invalid = await mcp.callTool({
      name: "propose_purchase",
      arguments: { mandateId: "mandate-1", productId: "x", source: "amazon", quantity: 0 },
    });
    expect(invalid.isError).toBe(true);
    const priced = await mcp.callTool({
      name: "search_products",
      arguments: { mandateId: "mandate-1", maxPriceMinor: 1.5 },
    });
    expect(priced.isError).toBe(true);
    expect(client.proposePurchase).not.toHaveBeenCalled();
    expect(client.searchProducts).not.toHaveBeenCalled();
  });

  it("maps gateway failures to safe tool errors", async () => {
    const mcp = await connect(
      mockClient({
        listMandates: vi
          .fn()
          .mockRejectedValue(
            new MandatePayApiError(
              403,
              "AGENT_DISABLED",
              "The shopping agent is temporarily unavailable.",
            ),
          ),
        getMandate: vi.fn().mockRejectedValue(new Error("socket hang up at 10.0.0.1")),
      }),
    );
    const disabled = await mcp.callTool({ name: "list_mandates", arguments: {} });
    expect(disabled.isError).toBe(true);
    expect(text(disabled)).toBe(
      "MandatePay: The shopping agent is temporarily unavailable. (AGENT_DISABLED)",
    );
    const internal = await mcp.callTool({ name: "get_mandate", arguments: { mandateId: "m" } });
    expect(internal.isError).toBe(true);
    expect(text(internal)).not.toContain("10.0.0.1");
  });
});
