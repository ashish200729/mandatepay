import { describe, expect, it, vi } from "vitest";
import {
  MandatePayApiError,
  agentTokenFromAuthorization,
  createMandatePayClient,
  gatewayBaseUrl,
} from "../src/api-client.js";
import { TOKEN, jsonResponse, mandate, proposal } from "./fixtures.js";

function client(fetchMock: typeof fetch, timeoutMs?: number) {
  return createMandatePayClient({
    apiUrl: "http://127.0.0.1:4000",
    token: TOKEN,
    fetch: fetchMock,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

describe("gateway base URL", () => {
  it("appends the gateway path once", () => {
    expect(gatewayBaseUrl("https://api.example.com")).toBe(
      "https://api.example.com/api/agent-gateway/v1",
    );
    expect(gatewayBaseUrl("https://api.example.com/api/agent-gateway/v1/")).toBe(
      "https://api.example.com/api/agent-gateway/v1",
    );
    expect(gatewayBaseUrl("http://localhost:4000")).toBe(
      "http://localhost:4000/api/agent-gateway/v1",
    );
  });

  it("refuses plaintext remote hosts, credentials and non-URLs", () => {
    expect(() => gatewayBaseUrl("http://api.example.com")).toThrow(/https/u);
    expect(() => gatewayBaseUrl("https://user:pass@api.example.com")).toThrow();
    expect(() => gatewayBaseUrl("https://api.example.com/?token=x")).toThrow();
    expect(() => gatewayBaseUrl("not a url")).toThrow();
  });

  it("requires an agent token", () => {
    expect(() =>
      createMandatePayClient({ apiUrl: "https://api.example.com", token: "secret" }),
    ).toThrow(/mp_agent_/u);
    expect(agentTokenFromAuthorization(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(agentTokenFromAuthorization("Bearer nope")).toBeNull();
    expect(agentTokenFromAuthorization(undefined)).toBeNull();
  });
});

describe("gateway requests", () => {
  it("sends the bearer token and validates the response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ mandates: [mandate] }));
    const result = await client(fetchMock).listMandates();
    expect(result.mandates[0]?.id).toBe("mandate-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4000/api/agent-gateway/v1/mandates");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init?.redirect).toBe("error");
  });

  it("encodes path segments and posts only the fields it was given", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(proposal, 201));
    await client(fetchMock).proposePurchase({
      mandateId: "mandate-1",
      productId: "demo-headphones-139",
      source: "demo",
      quantity: 1,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      mandateId: "mandate-1",
      productId: "demo-headphones-139",
      source: "demo",
      quantity: 1,
    });
    fetchMock.mockResolvedValue(jsonResponse({ error: "Not found.", code: "NOT_FOUND" }, 404));
    await expect(client(fetchMock).getProposal("../admin")).rejects.toBeInstanceOf(
      MandatePayApiError,
    );
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "http://127.0.0.1:4000/api/agent-gateway/v1/proposals/..%2Fadmin",
    );
  });

  it("maps gateway errors to safe codes and messages", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ error: "Token revoked.", code: "AGENT_TOKEN_INVALID" }, 401),
      )
      .mockResolvedValueOnce(new Response("<html>oops</html>", { status: 502 }))
      .mockResolvedValueOnce(
        jsonResponse({ error: "Bad\nline\u0007 text", code: "lower-case-not-allowed" }, 409),
      );
    const api = client(fetchMock);
    await expect(api.listMandates()).rejects.toMatchObject({
      status: 401,
      code: "AGENT_TOKEN_INVALID",
      message: "Token revoked.",
    });
    await expect(api.listMandates()).rejects.toMatchObject({
      status: 502,
      code: "HTTP_502",
      message: "MandatePay is temporarily unavailable. Retry shortly.",
    });
    await expect(api.listMandates()).rejects.toMatchObject({
      status: 409,
      code: "HTTP_409",
      message: "Bad line text",
    });
  });

  it("rejects responses that do not match the contract", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ mandates: [{ id: 1 }] }));
    await expect(client(fetchMock).listMandates()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("reports network failures and timeouts without leaking the token", async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed ${TOKEN}`));
    const failure = await client(network)
      .listMandates()
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "NETWORK_ERROR" });
    expect(String((failure as Error).message)).not.toContain(TOKEN);

    const slow = vi.fn<typeof fetch>((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
        );
      });
    });
    await expect(client(slow, 20).listMandates()).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
