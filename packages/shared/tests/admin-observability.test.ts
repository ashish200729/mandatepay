import { describe, expect, it } from "vitest";
import {
  AdminAgentRunSchema,
  AdminSystemHealthSchema,
  aggregateHealth,
  assertOperationalRecord,
  classifyAgentFailure,
  safeBuild,
  safeModelId,
  workerLiveness,
} from "../src/admin-observability.js";

describe("operational telemetry safety", () => {
  it("classifies agent failures without keeping provider text", () => {
    expect(classifyAgentFailure("UPSTREAM_TIMEOUT")).toBe("TIMEOUT");
    expect(classifyAgentFailure("SHOPPING_AI_UNAVAILABLE")).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyAgentFailure("TOOL_HANDLER_FAILED")).toBe("TOOL_FAILURE");
    expect(classifyAgentFailure("the provider said sk_live_secret")).toBe("UNKNOWN");
  });

  it("rejects transcripts, secrets, and chain-of-thought fields", () => {
    expect(() => assertOperationalRecord({ message: "buy shoes" })).toThrow(/FORBIDDEN_FIELD/u);
    expect(() => assertOperationalRecord({ reasoning: "step by step" })).toThrow(
      /FORBIDDEN_FIELD/u,
    );
    expect(() => assertOperationalRecord({ arguments: { query: "shoes" } })).toThrow(
      /FORBIDDEN_FIELD/u,
    );
    expect(() => assertOperationalRecord({ note: "bearer super-secret-token" })).toThrow(
      /SENSITIVE/u,
    );
    expect(() =>
      assertOperationalRecord({
        modelId: "sarvam-105b",
        outcome: "SUCCEEDED",
        errorClass: "NONE",
      }),
    ).not.toThrow();
  });

  it("keeps model identifiers and drops unsafe build values", () => {
    expect(safeModelId("sarvam-105b")).toBe("sarvam-105b");
    expect(safeModelId("https://user:pass@example.test/v1")).toBe("unspecified");
    expect(safeBuild({ commitSha: "abc1234", version: "admin-1" })).toEqual({
      commitSha: "abc1234",
      version: "admin-1",
    });
    expect(safeBuild({ commitSha: "not a sha", version: "has spaces" }).commitSha).toBeNull();
  });

  it("treats a missing heartbeat as unknown and a stale one as degraded", () => {
    const now = new Date("2026-10-07T00:00:00.000Z");
    expect(workerLiveness({ heartbeatAt: null, outcome: null, now }).status).toBe("unknown");
    expect(
      workerLiveness({
        heartbeatAt: new Date("2026-10-06T00:00:00.000Z"),
        outcome: "SUCCEEDED",
        now,
      }).status,
    ).toBe("degraded");
    expect(
      workerLiveness({
        heartbeatAt: new Date("2026-10-06T23:50:00.000Z"),
        outcome: "SUCCEEDED",
        now,
      }).status,
    ).toBe("ready");
  });

  it("does not let an unconfigured integration make the platform unknown", () => {
    expect(
      aggregateHealth([
        { status: "ready", configured: null },
        { status: "unknown", configured: false },
      ]),
    ).toBe("ready");
    expect(
      aggregateHealth([
        { status: "ready", configured: null },
        { status: "unavailable", configured: true },
      ]),
    ).toBe("unavailable");
  });

  it("rejects an agent run that carries a transcript", () => {
    expect(
      AdminAgentRunSchema.safeParse({
        id: "11111111-1111-4111-8111-111111111111",
        requestId: "agent-run-observable-01",
        userId: "user-1",
        modelId: "sarvam-105b",
        startedAt: "2026-10-07T00:00:00.000Z",
        completedAt: "2026-10-07T00:00:01.000Z",
        durationMs: 1000,
        outcome: "SUCCEEDED",
        errorClass: "NONE",
        proposalId: null,
        refundDraftId: null,
        tools: [],
        message: "secret prompt",
      }).success,
    ).toBe(false);
    expect(AdminSystemHealthSchema.safeParse({ token: "secret" }).success).toBe(false);
  });
});
