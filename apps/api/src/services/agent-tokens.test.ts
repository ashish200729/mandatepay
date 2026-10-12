import { describe, expect, it, vi } from "vitest";
import {
  CreateAgentTokenSchema,
  bearerAgentToken,
  createGatewayPrincipals,
  deriveAgentTokenKey,
  externalAgentModelId,
  generateAgentToken,
  hashAgentToken,
  isAgentTokenFormat,
} from "./agent-tokens.js";

const secret = "unit-test-only-auth-secret-with-32-characters";

describe("agent access token format and hashing", () => {
  it("generates distinct 32-byte mp_agent_ tokens", () => {
    const first = generateAgentToken();
    const second = generateAgentToken();
    expect(first).toMatch(/^mp_agent_[A-Za-z0-9_-]{43}$/u);
    expect(isAgentTokenFormat(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("hashes with an HKDF key separate from the auth secret", () => {
    const key = deriveAgentTokenKey(secret);
    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.from(secret).subarray(0, 32))).toBe(false);
    const token = generateAgentToken();
    const digest = hashAgentToken(key, token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashAgentToken(key, token)).toBe(digest);
    expect(hashAgentToken(deriveAgentTokenKey(`${secret}-other`), token)).not.toBe(digest);
  });

  it("reads only well-formed bearer tokens", () => {
    const token = generateAgentToken();
    expect(bearerAgentToken(undefined)).toBeNull();
    expect(bearerAgentToken(`Bearer ${token}`)).toBe(token);
    expect(bearerAgentToken(`bearer   ${token}`)).toBe(token);
    expect(bearerAgentToken(`Basic ${token}`)).toBe("");
    expect(bearerAgentToken(`Bearer ${token} extra`)).toBe("");
    expect(bearerAgentToken("Bearer mp_agent_short")).toBe("");
    expect(bearerAgentToken(`Bearer ${token.replace("mp_agent_", "mp_admin_")}`)).toBe("");
  });
});

describe("token creation input", () => {
  const valid = { name: "Claude Desktop", scopes: ["READ", "PROPOSE"], expiresInDays: 30 };

  it("accepts READ with optional PROPOSE and AUTOPAY", () => {
    expect(CreateAgentTokenSchema.safeParse(valid).success).toBe(true);
    expect(
      CreateAgentTokenSchema.safeParse({ ...valid, scopes: ["READ", "PROPOSE", "AUTOPAY"] })
        .success,
    ).toBe(true);
  });

  it.each([
    { ...valid, scopes: [] },
    { ...valid, scopes: ["PROPOSE"] },
    { ...valid, scopes: ["READ", "AUTOPAY"] },
    { ...valid, scopes: ["READ", "READ"] },
    { ...valid, scopes: ["READ", "ADMIN"] },
    { ...valid, expiresInDays: 91 },
    { ...valid, expiresInDays: 0 },
    { ...valid, name: "" },
    { ...valid, name: "x".repeat(65) },
    { ...valid, name: "<script>" },
    { ...valid, name: "Bad‮Name" },
    { ...valid, extra: true },
  ])("rejects %j", (input) => {
    expect(CreateAgentTokenSchema.safeParse(input).success).toBe(false);
  });
});

describe("external agent model ids", () => {
  it("are telemetry-safe slugs", () => {
    expect(externalAgentModelId("Claude Desktop")).toBe("external:claude-desktop");
    expect(externalAgentModelId("Cursor (work)")).toBe("external:cursor-work");
    expect(externalAgentModelId("***")).toBe("external:agent");
    expect(externalAgentModelId("x".repeat(64))).toMatch(/^external:x{55}$/u);
  });
});

describe("gateway principals", () => {
  it("are single use", () => {
    const principals = createGatewayPrincipals();
    const nonce = principals.issue("user-1");
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(principals.consume(nonce)).toBe("user-1");
    expect(principals.consume(nonce)).toBeNull();
  });

  it("reject unknown, malformed and expired values", () => {
    vi.useFakeTimers();
    try {
      const principals = createGatewayPrincipals({ ttlMs: 1_000 });
      expect(principals.consume(undefined)).toBeNull();
      expect(principals.consume("A".repeat(43))).toBeNull();
      expect(principals.consume("short")).toBeNull();
      const nonce = principals.issue("user-1");
      vi.advanceTimersByTime(1_001);
      expect(principals.consume(nonce)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuse to grow without bound", () => {
    const principals = createGatewayPrincipals({ capacity: 2 });
    principals.issue("a");
    principals.issue("b");
    expect(() => principals.issue("c")).toThrow();
  });
});
