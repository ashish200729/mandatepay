import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHttpHandler } from "../src/http.js";
import { OTHER_TOKEN, TOKEN, jsonResponse, mandate } from "./fixtures.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function start(fetchMock: typeof fetch, allowedOrigins: string[] = []) {
  const handler = createMcpHttpHandler({
    apiUrl: "http://127.0.0.1:4000",
    fetch: fetchMock,
    maxBodyBytes: 4_096,
    allowedOrigins,
  });
  const server = createServer((request, response) => void handler(request, response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function rpc(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const callTool = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "list_mandates", arguments: {} },
});

describe("Streamable HTTP MCP endpoint", () => {
  it("serves health without a token", async () => {
    const base = await start(vi.fn<typeof fetch>());
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "mandatepay-mcp" });
  });

  it("forwards each request's own bearer token to the gateway", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({ mandates: [mandate] }));
    const base = await start(fetchMock);
    const initialize = await rpc(
      base,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(initialize.status).toBe(200);
    expect((await initialize.json()).result.serverInfo.name).toBe("mandatepay");
    expect(fetchMock).not.toHaveBeenCalled();

    for (const [index, token] of [TOKEN, OTHER_TOKEN].entries()) {
      const response = await rpc(base, callTool(index + 2), { authorization: `Bearer ${token}` });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.result.structuredContent).toEqual({ mandates: [mandate] });
      const init = fetchMock.mock.calls[index]![1];
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    }
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:4000/api/agent-gateway/v1/mandates");
  });

  it("requires a well-formed agent token", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const base = await start(fetchMock);
    for (const headers of [{}, { authorization: "Bearer sk-live-123" }]) {
      const response = await rpc(base, callTool(1), headers);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toMatch(/^Bearer /u);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps CORS off, limits body size and allows only POST", async () => {
    const base = await start(vi.fn<typeof fetch>());
    const browser = await rpc(base, callTool(1), {
      authorization: `Bearer ${TOKEN}`,
      origin: "https://evil.example",
    });
    expect(browser.status).toBe(403);
    expect(browser.headers.get("access-control-allow-origin")).toBeNull();

    const large = await rpc(base, JSON.stringify({ padding: "x".repeat(5_000) }), {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(large.status).toBe(413);

    const malformed = await rpc(base, "{not json", { authorization: `Bearer ${TOKEN}` });
    expect(malformed.status).toBe(400);

    const get = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it("allows an explicitly configured browser origin", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ mandates: [] }));
    const base = await start(fetchMock, ["https://agent.example"]);
    const response = await rpc(base, callTool(1), {
      authorization: `Bearer ${TOKEN}`,
      origin: "https://agent.example",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://agent.example");
  });
});
