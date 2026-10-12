"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Bot, Check, Copy, LoaderCircle, TriangleAlert } from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { formatUtcDate } from "@/lib/mandates/money";
import {
  AGENT_TOKEN_EXPIRY_DAYS,
  claudeDesktopConfig,
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
  type AgentToken,
  type AgentTokenExpiryDays,
  type AgentTokenScope,
} from "@/lib/agent-tokens/client";
import { WorkspaceNotice, workspaceField } from "@/components/workspace-ui";

// Long labels must wrap inside the card on 320px screens instead of overflowing.
const WRAPPING_BUTTON = "h-auto min-h-11 max-w-full whitespace-normal py-2.5 text-center";
const MAX_ACTIVE = 10;

const SCOPE_COPY: Record<AgentTokenScope, { label: string; detail: string }> = {
  READ: {
    label: "Read (always on)",
    detail:
      "See your active mandates, search products within them, run the policy simulator and check proposal and order status.",
  },
  PROPOSE: {
    label: "Propose purchases",
    detail:
      "Create purchase proposals. AgentGuard decides every one from your mandate; the agent can never approve, pay or change a mandate.",
  },
  AUTOPAY: {
    label: "Autopay with saved PayPal",
    detail:
      "Lets this agent’s AgentGuard-ALLOW proposals be paid immediately with your saved PayPal method, within your automatic limit, without asking you first.",
  },
};

function message(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2_000);
          },
          () => setCopied(false),
        );
      }}
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), WRAPPING_BUTTON)}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {copied ? "Copied" : label}
    </button>
  );
}

/**
 * Settings card for connecting external AI agents through MCP. A token is
 * shown once, right after it is created; MandatePay stores only a keyed hash.
 */
export function AgentConnections() {
  const id = useId();
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [apiUrl, setApiUrl] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("Claude Desktop");
  const [propose, setPropose] = useState(true);
  const [autopay, setAutopay] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<AgentTokenExpiryDays>(30);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listAgentTokens()
      .then((value) => {
        if (!active) return;
        setTokens(value.agentTokens);
        setApiUrl(value.apiUrl);
        setAvailable(value.available);
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause, "We couldn’t load your agent connections."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const activeCount = tokens.filter((token) => token.status === "ACTIVE").length;
  const trimmedName = name.trim();

  const create = useCallback(async () => {
    if (busy || !trimmedName) return;
    setBusy("create");
    setError(null);
    setCreated(null);
    const scopes: AgentTokenScope[] = [
      "READ",
      ...(propose ? (["PROPOSE"] as const) : []),
      ...(propose && autopay ? (["AUTOPAY"] as const) : []),
    ];
    try {
      const result = await createAgentToken({ name: trimmedName, scopes, expiresInDays });
      setTokens((current) => [result.agentToken, ...current]);
      if (result.apiUrl) setApiUrl(result.apiUrl);
      setCreated({ token: result.token, name: result.agentToken.name });
    } catch (cause) {
      setError(message(cause, "We couldn’t create the agent connection. Try again."));
    } finally {
      setBusy(null);
    }
  }, [autopay, busy, expiresInDays, propose, trimmedName]);

  const revoke = useCallback(
    async (tokenId: string) => {
      if (busy) return;
      setBusy(tokenId);
      setError(null);
      try {
        const revoked = await revokeAgentToken(tokenId);
        setTokens((current) => current.map((token) => (token.id === tokenId ? revoked : token)));
        setConfirmRevoke(null);
      } catch (cause) {
        setError(message(cause, "We couldn’t revoke the agent connection. Try again."));
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const config = created
    ? claudeDesktopConfig(apiUrl ?? "https://your-mandatepay-api", created.token)
    : "";

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-6"
    >
      <div className="flex items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-sand">
          <Bot size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="text-lg font-medium leading-6">
            Connect an AI agent (MCP)
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            Let Claude, ChatGPT, Cursor or your own agent shop through MandatePay. The agent
            proposes; AgentGuard decides every purchase from your mandates; PayPal only runs what
            AgentGuard and you allow. Agents can never approve, pay, refund or edit mandates.
          </p>

          {error ? (
            <div className="mt-4">
              <WorkspaceNotice error>{error}</WorkspaceNotice>
            </div>
          ) : null}
          {!loading && !available ? (
            <div className="mt-4">
              <WorkspaceNotice>
                Agent connections are not configured on this server.
              </WorkspaceNotice>
            </div>
          ) : null}

          {created ? (
            <div
              className="mt-5 space-y-3 rounded-lg border border-border bg-secondary/50 p-4"
              aria-live="polite"
            >
              <p className="flex items-start gap-2 text-sm font-medium leading-6">
                <TriangleAlert size={16} className="mt-1 shrink-0" aria-hidden="true" />
                Copy this token for {created.name} now. It is shown only once and works like a
                password for this connection.
              </p>
              <label htmlFor={`${id}-token`} className="sr-only">
                Agent token
              </label>
              <input
                id={`${id}-token`}
                readOnly
                value={created.token}
                onFocus={(event) => event.currentTarget.select()}
                className={cn(workspaceField, "font-mono text-xs")}
              />
              <div className="flex flex-wrap gap-2">
                <CopyButton value={created.token} label="Copy token" />
                <CopyButton value={config} label="Copy Claude Desktop config" />
              </div>
              <details className="text-sm">
                <summary className="flex min-h-11 cursor-pointer items-center font-medium">
                  Claude Desktop config (claude_desktop_config.json)
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-border bg-card p-3 text-xs leading-5 whitespace-pre-wrap break-all">
                  {config}
                </pre>
                <p className="mt-2 leading-6 text-muted-foreground">
                  Replace the path with your MandatePay checkout’s{" "}
                  <code>apps/mcp/dist/stdio.js</code> (build it with{" "}
                  <code>pnpm --filter @mandatepay/mcp build</code>). Remote agents can instead call
                  the MCP HTTP endpoint with this token as a Bearer header.
                </p>
              </details>
              <button
                type="button"
                onClick={() => setCreated(null)}
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }), WRAPPING_BUTTON)}
              >
                I’ve saved it
              </button>
            </div>
          ) : null}

          <form
            className="mt-5 space-y-4 border-t border-border pt-5"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="min-w-0">
              <label htmlFor={`${id}-name`} className="text-sm font-medium">
                Connection name
              </label>
              <input
                id={`${id}-name`}
                value={name}
                maxLength={64}
                autoComplete="off"
                onChange={(event) => setName(event.currentTarget.value)}
                className={cn(workspaceField, "mt-2")}
              />
            </div>
            <fieldset className="min-w-0 space-y-3">
              <legend className="text-sm font-medium">What this agent may do</legend>
              <div className="flex min-h-11 items-start gap-3 text-sm">
                <input
                  id={`${id}-read`}
                  type="checkbox"
                  checked
                  disabled
                  aria-describedby={`${id}-read-detail`}
                  className="mt-1 size-4 shrink-0 accent-primary"
                />
                <label htmlFor={`${id}-read`} className="leading-6">
                  <span className="font-medium">{SCOPE_COPY.READ.label}</span>
                  <span id={`${id}-read-detail`} className="block text-muted-foreground">
                    {SCOPE_COPY.READ.detail}
                  </span>
                </label>
              </div>
              <div className="flex min-h-11 items-start gap-3 text-sm">
                <input
                  id={`${id}-propose`}
                  type="checkbox"
                  checked={propose}
                  disabled={busy !== null}
                  onChange={(event) => {
                    setPropose(event.currentTarget.checked);
                    if (!event.currentTarget.checked) setAutopay(false);
                  }}
                  className="mt-1 size-4 shrink-0 accent-primary"
                />
                <label htmlFor={`${id}-propose`} className="leading-6">
                  <span className="font-medium">{SCOPE_COPY.PROPOSE.label}</span>
                  <span className="block text-muted-foreground">{SCOPE_COPY.PROPOSE.detail}</span>
                </label>
              </div>
              <div className="flex min-h-11 items-start gap-3 text-sm">
                <input
                  id={`${id}-autopay`}
                  type="checkbox"
                  checked={autopay}
                  disabled={!propose || busy !== null}
                  aria-describedby={`${id}-autopay-warning`}
                  onChange={(event) => setAutopay(event.currentTarget.checked)}
                  className="mt-1 size-4 shrink-0 accent-primary"
                />
                <label htmlFor={`${id}-autopay`} className="leading-6">
                  <span className="font-medium">{SCOPE_COPY.AUTOPAY.label}</span>
                  <span className="block text-muted-foreground">{SCOPE_COPY.AUTOPAY.detail}</span>
                  <span id={`${id}-autopay-warning`} className="mt-1 flex items-start gap-2">
                    <TriangleAlert size={14} className="mt-1 shrink-0" aria-hidden="true" />
                    <span>
                      Warning: with this on, an agent’s ALLOW proposals are charged to your saved
                      PayPal method. Turn it on only for agents you trust.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>
            <div className="min-w-0 sm:max-w-56">
              <label htmlFor={`${id}-expiry`} className="text-sm font-medium">
                Expires after
              </label>
              <select
                id={`${id}-expiry`}
                value={expiresInDays}
                onChange={(event) =>
                  setExpiresInDays(Number(event.currentTarget.value) as AgentTokenExpiryDays)
                }
                className={cn(workspaceField, "mt-2")}
              >
                {AGENT_TOKEN_EXPIRY_DAYS.map((days) => (
                  <option key={days} value={days}>
                    {days} days
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={
                loading || !available || busy !== null || !trimmedName || activeCount >= MAX_ACTIVE
              }
              className={cn(buttonVariants(), WRAPPING_BUTTON)}
            >
              {busy === "create" ? (
                <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
              ) : null}
              {busy === "create" ? "Creating…" : "Create agent token"}
            </button>
            {activeCount >= MAX_ACTIVE ? (
              <p className="text-sm text-muted-foreground">
                You have {MAX_ACTIVE} active connections. Revoke one to create another.
              </p>
            ) : null}
          </form>

          <div className="mt-6 border-t border-border pt-5">
            <h3 className="text-sm font-medium">Your agent connections</h3>
            {loading ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                Loading agent connections…
              </p>
            ) : tokens.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No agents are connected yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border border-y border-border">
                {tokens.map((token) => (
                  <li key={token.id} className="flex flex-wrap items-start gap-3 py-4 text-sm">
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="break-words font-medium">
                        {token.name}{" "}
                        <span className="font-normal text-muted-foreground">
                          ·{" "}
                          {token.status === "ACTIVE"
                            ? "Active"
                            : token.status === "EXPIRED"
                              ? "Expired"
                              : "Revoked"}
                        </span>
                      </p>
                      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {token.tokenPrefix}…
                      </p>
                      <p className="mt-1 leading-6 text-muted-foreground">
                        {token.scopes.join(" · ")} · expires {formatUtcDate(token.expiresAt)} · last
                        used {token.lastUsedAt ? formatUtcDate(token.lastUsedAt) : "never"}
                      </p>
                    </div>
                    {token.status === "ACTIVE" ? (
                      confirmRevoke === token.id ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void revoke(token.id)}
                            disabled={busy !== null}
                            aria-label={`Yes, revoke ${token.name}`}
                            className={cn(
                              buttonVariants({ variant: "outline", size: "sm" }),
                              WRAPPING_BUTTON,
                            )}
                          >
                            {busy === token.id ? (
                              <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                            ) : null}
                            Yes, revoke
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmRevoke(null)}
                            disabled={busy !== null}
                            className={cn(
                              buttonVariants({ variant: "ghost", size: "sm" }),
                              WRAPPING_BUTTON,
                            )}
                          >
                            Keep it
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmRevoke(token.id)}
                          aria-label={`Revoke ${token.name}`}
                          className={cn(
                            buttonVariants({ variant: "outline", size: "sm" }),
                            WRAPPING_BUTTON,
                          )}
                        >
                          Revoke
                        </button>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
