#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMandatePayClient } from "./api-client.js";
import { createMandatePayMcpServer } from "./server.js";

/**
 * Local MCP server for desktop agents (for example Claude Desktop). It reads
 * MANDATEPAY_API_URL and MANDATEPAY_AGENT_TOKEN from its environment. stdout
 * carries the MCP protocol, so diagnostics go to stderr and never include the token.
 */
async function main() {
  const apiUrl = process.env.MANDATEPAY_API_URL ?? "http://127.0.0.1:4000";
  const token = process.env.MANDATEPAY_AGENT_TOKEN ?? "";
  let client;
  try {
    client = createMandatePayClient({ apiUrl, token });
  } catch (cause) {
    process.stderr.write(
      `mandatepay-mcp: ${cause instanceof Error ? cause.message : "invalid configuration"} Set MANDATEPAY_API_URL and MANDATEPAY_AGENT_TOKEN.\n`,
    );
    process.exit(1);
  }
  const server = createMandatePayMcpServer(client);
  await server.connect(new StdioServerTransport());
}

main().catch(() => {
  process.stderr.write("mandatepay-mcp: the server stopped unexpectedly.\n");
  process.exit(1);
});
