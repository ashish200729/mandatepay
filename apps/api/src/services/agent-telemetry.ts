import { DatabaseError, ObservabilityRepository, type DatabaseClient } from "@mandatepay/database";
import {
  MandateParserError,
  OpenAIProviderError,
  ShoppingAgentError,
  type ShoppingAgentToolHandlerContext,
  type ShoppingAgentToolHandlers,
  type ShoppingAgentToolName,
} from "@mandatepay/agent";
import {
  AGENT_TOOL_NAMES,
  classifyAgentFailure,
  safeModelId,
  safeRequestId,
  type AgentToolFact,
} from "@mandatepay/shared";
type ToolFact = AgentToolFact;

export function agentFailureClass(cause: unknown) {
  if (cause instanceof OpenAIProviderError || cause instanceof ShoppingAgentError) {
    return classifyAgentFailure(cause.code);
  }
  if (cause instanceof MandateParserError) return classifyAgentFailure("MODEL_RESPONSE_INVALID");
  if (cause instanceof DatabaseError) return classifyAgentFailure(cause.code);
  return classifyAgentFailure(undefined);
}

export function proposalIdFrom(proposals: readonly unknown[]) {
  for (const entry of proposals) {
    if (!entry || typeof entry !== "object") continue;
    const proposal = (entry as { proposal?: { id?: unknown } }).proposal;
    if (proposal && typeof proposal.id === "string") return proposal.id;
  }
  return null;
}

export function refundDraftIdFrom(draft: unknown) {
  if (!draft || typeof draft !== "object") return null;
  const paymentId = (draft as { paymentId?: unknown }).paymentId;
  return typeof paymentId === "string" ? paymentId : null;
}

export function traceShoppingTools(
  tools: ShoppingAgentToolHandlers,
  facts: ToolFact[],
): ShoppingAgentToolHandlers {
  const traced: Record<string, ShoppingAgentToolHandlers[ShoppingAgentToolName]> = {};
  for (const name of AGENT_TOOL_NAMES) {
    const handler = tools[name];
    if (!handler) continue;
    traced[name] = (async (input: never, context: ShoppingAgentToolHandlerContext) => {
      const started = new Date();
      try {
        const result = await handler(input, context);
        const failed = hasToolError(result);
        facts.push(fact(name, started, failed));
        return result;
      } catch (error) {
        facts.push(fact(name, started, true));
        throw error;
      }
    }) as ShoppingAgentToolHandlers[typeof name];
  }
  return traced;
}

function fact(name: (typeof AGENT_TOOL_NAMES)[number], started: Date, failed: boolean): ToolFact {
  const completed = new Date();
  return {
    name,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    durationMs: Math.min(600_000, Math.max(0, completed.getTime() - started.getTime())),
    outcome: failed ? "FAILED" : "SUCCEEDED",
    errorClass: failed ? "TOOL_FAILURE" : "NONE",
  };
}

function hasToolError(result: unknown) {
  return Boolean(result && typeof result === "object" && "error" in result && result.error != null);
}

export async function persistAgentRun(
  database: DatabaseClient,
  input: {
    requestId: string;
    userId: string;
    modelId?: string;
    startedAt: Date;
    completedAt: Date;
    outcome: "SUCCEEDED" | "FAILED";
    errorClass: ToolFact["errorClass"];
    proposalId: string | null;
    refundDraftId: string | null;
    tools: readonly ToolFact[];
  },
) {
  try {
    await new ObservabilityRepository(database).recordAgentRun({
      requestId: safeRequestId(input.requestId),
      userId: input.userId,
      modelId: safeModelId(input.modelId),
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      outcome: input.outcome,
      errorClass: input.errorClass,
      proposalId: input.proposalId,
      refundDraftId: input.refundDraftId,
      tools: input.tools.map((tool) => ({
        name: tool.name,
        startedAt: new Date(tool.startedAt),
        completedAt: tool.completedAt ? new Date(tool.completedAt) : null,
        durationMs: tool.durationMs,
        outcome: tool.outcome,
        errorClass: tool.errorClass,
      })),
    });
  } catch {
    // A telemetry failure must not change the shopping response or store the rejected record.
  }
}
