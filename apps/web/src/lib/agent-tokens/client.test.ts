import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiUrlFromGateway,
  claudeDesktopConfig,
  createAgentToken,
  listAgentTokens,
  readAgentToken,
  revokeAgentToken,
} from "./client";

const TOKEN = `mp_agent_${"x".repeat(43)}`;
const record = {
  id: "token-1",
  name: "Claude Desktop",
  tokenPrefix: "mp_agent_xxxxxx",
  scopes: ["PROPOSE", "READ", "ADMIN"],
  status: "ACTIVE",
  expiresAt: "2026-11-12T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-10-13T00:00:00.000Z",
  tokenHash: "never-shown",
};

function respond(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("agent token readers", () => {
  it("keeps display fields and known scopes only", () => {
    const token = readAgentToken(record);
    expect(token.scopes).toEqual(["READ", "PROPOSE"]);
    expect(JSON.stringify(token)).not.toContain("never-shown");
  });

  it("rejects malformed records", () => {
    expect(() => readAgentToken({ ...record, status: "MAYBE" })).toThrow();
    expect(() => readAgentToken({ ...record, scopes: [] })).toThrow();
    expect(() => readAgentToken({ ...record, id: "../x" })).toThrow();
    expect(() => readAgentToken({ ...record, tokenPrefix: "sk_live" })).toThrow();
    expect(() => readAgentToken(null)).toThrow();
  });

  it("derives the API origin from the gateway URL", () => {
    expect(apiUrlFromGateway({ baseUrl: "https://api.example.com/api/agent-gateway/v1" })).toBe(
      "https://api.example.com",
    );
    expect(apiUrlFromGateway({ baseUrl: "javascript:alert(1)" })).toBeNull();
    expect(
      apiUrlFromGateway({ baseUrl: "https://u:p@api.example.com/api/agent-gateway/v1" }),
    ).toBeNull();
    expect(apiUrlFromGateway(null)).toBeNull();
  });

  it("builds a Claude Desktop config with the API URL and token", () => {
    const config = JSON.parse(claudeDesktopConfig("https://api.example.com", TOKEN));
    expect(config.mcpServers.mandatepay).toMatchObject({
      command: "node",
      env: { MANDATEPAY_API_URL: "https://api.example.com", MANDATEPAY_AGENT_TOKEN: TOKEN },
    });
    expect(config.mcpServers.mandatepay.args[0]).toMatch(/apps\/mcp\/dist\/stdio\.js$/u);
  });
});

describe("agent token requests", () => {
  it("lists tokens through the same-origin BFF", async () => {
    const fetchMock = respond({
      agentTokens: [record],
      gateway: { baseUrl: "http://127.0.0.1:4000/api/agent-gateway/v1" },
      available: true,
    });
    vi.stubGlobal("fetch", fetchMock);
    const listed = await listAgentTokens();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/agent-tokens");
    expect(listed.apiUrl).toBe("http://127.0.0.1:4000");
    expect(listed.agentTokens).toHaveLength(1);
  });

  it("creates a token and accepts only an mp_agent_ value", async () => {
    vi.stubGlobal(
      "fetch",
      respond({ token: TOKEN, agentToken: record, gateway: { baseUrl: "x" } }, 201),
    );
    const created = await createAgentToken({
      name: "Claude Desktop",
      scopes: ["READ", "PROPOSE"],
      expiresInDays: 30,
    });
    expect(created.token).toBe(TOKEN);
    expect(created.apiUrl).toBeNull();

    vi.stubGlobal("fetch", respond({ token: "plain", agentToken: record }, 201));
    await expect(
      createAgentToken({ name: "x", scopes: ["READ"], expiresInDays: 7 }),
    ).rejects.toThrow();
  });

  it("surfaces server errors and encodes ids", async () => {
    const fetchMock = respond({ error: "Agent connection not found." }, 404);
    vi.stubGlobal("fetch", fetchMock);
    await expect(revokeAgentToken("a/b")).rejects.toMatchObject({
      message: "Agent connection not found.",
      status: 404,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/agent-tokens/a%2Fb/revoke");
  });
});
