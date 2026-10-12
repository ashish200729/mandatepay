import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  agentTokenFromAuthorization,
  createMandatePayClient,
  gatewayBaseUrl,
} from "./api-client.js";
import { createMandatePayMcpServer } from "./server.js";

export const MCP_PATH = "/mcp";
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export interface McpHttpOptions {
  /** MANDATEPAY_API_URL: the MandatePay API the gateway calls go to. */
  readonly apiUrl: string;
  readonly maxBodyBytes?: number;
  /**
   * Browser origins allowed to call this server. Empty by default: CORS is off
   * and any request carrying an Origin header is refused (DNS-rebinding defence).
   */
  readonly allowedOrigins?: readonly string[];
  readonly fetch?: typeof fetch;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers = {}) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function rpcError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers = {},
) {
  sendJson(response, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

class BodyTooLarge extends Error {}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * Stateless Streamable HTTP MCP endpoint. Each request's own
 * `Authorization: Bearer mp_agent_…` header is forwarded to the MandatePay
 * agent gateway; this server stores no token and keeps no session.
 */
export function createMcpHttpHandler(options: McpHttpOptions) {
  // Fail fast on a misconfigured API URL (for example plain http to a remote host).
  gatewayBaseUrl(options.apiUrl);
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  return async (request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? "/").split("?", 1)[0];
    if (path === "/health" && request.method === "GET") {
      return sendJson(response, 200, { status: "ok", service: "mandatepay-mcp" });
    }
    if (path !== MCP_PATH) return sendJson(response, 404, { error: "Not found." });

    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return rpcError(response, 403, -32000, "Browser origins are not allowed.");
    }
    const corsHeaders = origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
    if (request.method === "OPTIONS" && origin) {
      response.writeHead(204, {
        ...corsHeaders,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version",
        "access-control-max-age": "600",
      });
      return response.end();
    }
    if (request.method !== "POST") {
      // Stateless mode: no server-initiated streams or sessions to resume or delete.
      return rpcError(response, 405, -32000, "Method not allowed.", {
        allow: "POST",
        ...corsHeaders,
      });
    }

    const token = agentTokenFromAuthorization(request.headers.authorization);
    if (!token) {
      return rpcError(
        response,
        401,
        -32001,
        "Send a MandatePay agent token as `Authorization: Bearer mp_agent_…`.",
        { "www-authenticate": 'Bearer realm="mandatepay-mcp"', ...corsHeaders },
      );
    }

    let body: unknown;
    try {
      body = await readJsonBody(request, limit);
    } catch (cause) {
      return cause instanceof BodyTooLarge
        ? rpcError(response, 413, -32600, "Request body is too large.", corsHeaders)
        : rpcError(response, 400, -32700, "Request body is not valid JSON.", corsHeaders);
    }

    for (const [name, value] of Object.entries(corsHeaders)) response.setHeader(name, value);
    const client = createMandatePayClient({
      apiUrl: options.apiUrl,
      token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const server = createMandatePayMcpServer(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      rpcError(response, 500, -32603, "Internal server error.");
    }
  };
}

export function startMcpHttpServer(env: NodeJS.ProcessEnv = process.env): Server {
  const handler = createMcpHttpHandler({
    apiUrl: env.MANDATEPAY_API_URL ?? "http://127.0.0.1:4000",
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  const port = Number(env.PORT ?? 4300);
  const host = env.HOST ?? "127.0.0.1";
  server.listen(port, host, () => {
    process.stdout.write(`mandatepay-mcp listening on http://${host}:${port}${MCP_PATH}\n`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close());
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpHttpServer();
}
