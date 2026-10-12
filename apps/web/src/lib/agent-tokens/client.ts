export const AGENT_TOKEN_SCOPES = ["READ", "PROPOSE", "AUTOPAY"] as const;
export type AgentTokenScope = (typeof AGENT_TOKEN_SCOPES)[number];
export const AGENT_TOKEN_EXPIRY_DAYS = [7, 30, 90] as const;
export type AgentTokenExpiryDays = (typeof AGENT_TOKEN_EXPIRY_DAYS)[number];
export type AgentTokenStatus = "ACTIVE" | "EXPIRED" | "REVOKED";

export type AgentToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: AgentTokenScope[];
  status: AgentTokenStatus;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type AgentTokenList = {
  agentTokens: AgentToken[];
  /** The MandatePay API origin an MCP server should call (MANDATEPAY_API_URL). */
  apiUrl: string | null;
  available: boolean;
};

export type CreatedAgentToken = {
  /** Shown once. Never stored by the browser. */
  token: string;
  agentToken: AgentToken;
  apiUrl: string | null;
};

export class AgentTokenApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentTokenApiError";
  }
}

const TOKEN_PATTERN = /^mp_agent_[A-Za-z0-9_-]{43}$/u;
const GATEWAY_SUFFIX = "/api/agent-gateway/v1";
const STATUSES = new Set<AgentTokenStatus>(["ACTIVE", "EXPIRED", "REVOKED"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

export function readAgentToken(value: unknown): AgentToken {
  if (!isRecord(value)) throw new Error("The agent connection response was not valid.");
  const id = text(value.id, 128);
  const name = text(value.name, 64);
  const tokenPrefix = text(value.tokenPrefix, 24);
  const expiresAt = text(value.expiresAt, 40);
  const createdAt = text(value.createdAt, 40);
  const scopes = Array.isArray(value.scopes)
    ? AGENT_TOKEN_SCOPES.filter((scope) => (value.scopes as unknown[]).includes(scope))
    : [];
  if (
    !id ||
    !/^[A-Za-z0-9_-]+$/u.test(id) ||
    !name ||
    !tokenPrefix?.startsWith("mp_agent_") ||
    !expiresAt ||
    !createdAt ||
    !scopes.length ||
    typeof value.status !== "string" ||
    !STATUSES.has(value.status as AgentTokenStatus)
  ) {
    throw new Error("The agent connection response was not valid.");
  }
  return {
    id,
    name,
    tokenPrefix,
    scopes,
    status: value.status as AgentTokenStatus,
    expiresAt,
    lastUsedAt: text(value.lastUsedAt, 40),
    revokedAt: text(value.revokedAt, 40),
    createdAt,
  };
}

/** The API origin from the gateway URL the server reports, or null if it is not a safe URL. */
export function apiUrlFromGateway(value: unknown): string | null {
  const baseUrl = isRecord(value) ? value.baseUrl : null;
  if (typeof baseUrl !== "string") return null;
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (!url.pathname.endsWith(GATEWAY_SUFFIX)) return null;
    return `${url.origin}${url.pathname.slice(0, -GATEWAY_SUFFIX.length)}`;
  } catch {
    return null;
  }
}

async function request(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
    });
  } catch {
    throw new AgentTokenApiError("We couldn’t reach MandatePay. Check your connection.", 503);
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "We couldn’t update your agent connections. Try again.";
    throw new AgentTokenApiError(message.slice(0, 240), response.status);
  }
  return payload;
}

export async function listAgentTokens(): Promise<AgentTokenList> {
  const payload = await request("/api/agent-tokens");
  if (!isRecord(payload) || !Array.isArray(payload.agentTokens)) {
    throw new Error("The agent connection response was not valid.");
  }
  return {
    agentTokens: payload.agentTokens.map(readAgentToken),
    apiUrl: apiUrlFromGateway(payload.gateway),
    available: payload.available !== false,
  };
}

export async function createAgentToken(input: {
  name: string;
  scopes: AgentTokenScope[];
  expiresInDays: AgentTokenExpiryDays;
}): Promise<CreatedAgentToken> {
  const payload = await request("/api/agent-tokens", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (
    !isRecord(payload) ||
    typeof payload.token !== "string" ||
    !TOKEN_PATTERN.test(payload.token)
  ) {
    throw new Error("The agent connection response was not valid.");
  }
  return {
    token: payload.token,
    agentToken: readAgentToken(payload.agentToken),
    apiUrl: apiUrlFromGateway(payload.gateway),
  };
}

export async function revokeAgentToken(id: string): Promise<AgentToken> {
  const payload = await request(`/api/agent-tokens/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    body: "{}",
  });
  return readAgentToken(isRecord(payload) ? payload.agentToken : null);
}

/** Placeholder for the local checkout path; the browser cannot know it. */
export const MCP_STDIO_PATH_PLACEHOLDER = "/absolute/path/to/mandatepay/apps/mcp/dist/stdio.js";

/** Ready-to-paste `claude_desktop_config.json` for the local stdio MCP server. */
export function claudeDesktopConfig(apiUrl: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        mandatepay: {
          command: "node",
          args: [MCP_STDIO_PATH_PLACEHOLDER],
          env: { MANDATEPAY_API_URL: apiUrl, MANDATEPAY_AGENT_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
}
