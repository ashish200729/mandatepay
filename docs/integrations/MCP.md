# MandatePay MCP server

**AI proposes. AgentGuard authorizes. PayPal executes.** The MandatePay MCP server lets any
MCP-capable agent (Claude Desktop, Claude Code, ChatGPT connectors, Cursor or your own agent) shop
_through_ MandatePay. The external agent searches and proposes; AgentGuard decides every proposal
deterministically from the user's mandate; PayPal runs only what AgentGuard and the user allow.

```text
External agent ──MCP──▶ apps/mcp ──Bearer mp_agent_…──▶ API /api/agent-gateway/v1 ──▶ AgentGuard ──▶ PayPal
```

Status: implemented and covered by unit tests (`apps/mcp`, `apps/api`), an API integration test
against PostgreSQL (`apps/api/src/agent-gateway.integration.test.ts`) and a browser test
(`tests/e2e/agent-tokens.spec.ts`). It has not been verified with a hosted deployment or a
specific commercial MCP client.

## Tools

| Tool                | Scope   | What it does                                                                                      |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `list_mandates`     | READ    | Active mandates with budget and rules in USD cents and a one-line summary.                        |
| `get_mandate`       | READ    | One owned mandate.                                                                                |
| `search_products`   | READ    | Demo Catalog / Channel3 search with the chat's mandate pre-screen and prompt-injection screening. |
| `simulate_purchase` | READ    | AgentGuard's decision for a hypothetical purchase. Read-only; nothing is recorded.                |
| `propose_purchase`  | PROPOSE | Creates a proposal with server-owned price and totals and returns AgentGuard's decision.          |
| `get_proposal`      | READ    | A proposal's status, decision and deterministic explanation, plus the user's next step.           |
| `get_order_status`  | READ    | A payment's status only.                                                                          |

There is deliberately **no** tool or gateway route to approve or reject a proposal, start checkout,
capture, refund, or create or edit a mandate. Those stay with the signed-in human in MandatePay.
`propose_purchase` returns a `nextStep` link (approval inbox, Sandbox checkout or receipt) for the
agent to hand to the user.

## Security model

- **Agent access tokens.** Created in **Settings → Connect an AI agent (MCP)** with a name, scopes
  and an expiry of 7, 30 or 90 days. Format `mp_agent_<32 random bytes, base64url>`. The token is
  shown once; MandatePay stores only an HMAC-SHA256 of it, keyed with an HKDF-derived key
  (`mandatepay/agent-token/v1`) separate from the session secret. At most 10 active tokens per user.
  Creation and revocation are audited (`AGENT_TOKEN_CREATED`, `AGENT_TOKEN_REVOKED`).
- **Bearer only.** `/api/agent-gateway/v1/*` accepts only `Authorization: Bearer mp_agent_…`.
  Cookies are never read there, so there are no ambient credentials and no origin check is needed.
  Expired, revoked and disabled-account tokens are refused. `lastUsedAt` is updated at most once a
  minute.
- **Rate limits.** Per address (120/min), per token (30/min) and per user (60/min), on top of the
  existing per-user product, proposal and financial-mutation limits.
- **Same rules as the in-app chat.** The gateway calls the same customer routes and services: the
  shopping-agent and agent-proposal kill switches, maintenance mode, discovery switches, ownership,
  active-mandate checks, server-owned totals, AgentGuard evaluation and the autopay service. A
  product must be a Demo Catalog id or a result of this token's own search in the last 15 minutes.
  Only Demo Catalog products can be bought.
- **Untrusted product text.** Retailer strings reach the agent only inside
  `<untrusted_listing>` blocks; listings that try to instruct AI agents are excluded and, if proposed
  anyway, blocked by AgentGuard (`PRODUCT_CONTENT_MALICIOUS`).
- **Attribution.** Proposals made through a token record a `PRODUCT_SELECTED` audit event with
  `{ via: "agent-token", tokenId, tokenName }` and agent telemetry with model id
  `external:<token-name>`. No prompts or product text are stored in telemetry.
- **The MCP server holds no secrets.** The stdio server reads one token from its environment; the
  HTTP server forwards each request's own bearer token and keeps no session.

### Scopes

| Scope     | Grants                                                                                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `READ`    | Required. Mandates, search, simulator, proposal and order status.                                                                                                                                                                                                                                                      |
| `PROPOSE` | Create proposals for AgentGuard to decide.                                                                                                                                                                                                                                                                             |
| `AUTOPAY` | Requires `PROPOSE`. When AgentGuard returns ALLOW **and** the existing autopay conditions hold (saved PayPal, automatic permissions on, within the automatic limit, platform switches on), MandatePay pays immediately with the saved PayPal method. Without this scope, ALLOW proposals wait for the user's checkout. |

## Local setup (Claude Desktop, stdio)

1. Build the server: `pnpm --filter @mandatepay/mcp build`.
2. In MandatePay **Settings → Connect an AI agent (MCP)**, create a token. The page shows a
   ready-to-paste config; replace the path with your checkout's absolute path.
3. Add it to `claude_desktop_config.json` and restart Claude Desktop:

```json
{
  "mcpServers": {
    "mandatepay": {
      "command": "node",
      "args": ["/absolute/path/to/mandatepay/apps/mcp/dist/stdio.js"],
      "env": {
        "MANDATEPAY_API_URL": "http://127.0.0.1:4000",
        "MANDATEPAY_AGENT_TOKEN": "mp_agent_…"
      }
    }
  }
}
```

`MANDATEPAY_API_URL` is the API origin (not the web app). The client refuses plain `http` except
for `localhost`, `127.0.0.1` and `[::1]`, so a token is never sent unencrypted to a remote host.

## Remote setup (Streamable HTTP)

`pnpm --filter @mandatepay/mcp start` runs a stateless Streamable HTTP server:

- `POST /mcp` — MCP endpoint. Each request must carry `Authorization: Bearer mp_agent_…`; that
  header is forwarded to the gateway. Bodies over 256 KB are refused.
- `GET /health` — liveness.
- Environment: `MANDATEPAY_API_URL`, `PORT` (default 4300), `HOST` (default `127.0.0.1`),
  `MCP_ALLOWED_ORIGINS` (comma-separated). CORS is off by default and any request with an `Origin`
  header not in that list is refused.

`render.yaml` includes an optional `mandatepay-mcp` web service wired to the API's URL. Examples:

```bash
# Claude Code
claude mcp add --transport http mandatepay https://<mcp-host>/mcp \
  --header "Authorization: Bearer mp_agent_…"
```

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mandatepay": {
      "url": "https://<mcp-host>/mcp",
      "headers": { "Authorization": "Bearer mp_agent_…" }
    }
  }
}
```

Clients that only support OAuth for remote servers can use the stdio server instead.

## Using PayPal's Sandbox MCP server alongside

PayPal publishes its own MCP server (Sandbox endpoint `https://mcp.sandbox.paypal.com/http`) with
merchant-side tools such as orders, invoices and reporting for the PayPal account you sign in with.
Add it to the same client as a second server, next to `mandatepay`, for example in Cursor:

```json
{
  "mcpServers": {
    "mandatepay": {
      "url": "https://<mcp-host>/mcp",
      "headers": { "Authorization": "Bearer mp_agent_…" }
    },
    "paypal-sandbox": { "url": "https://mcp.sandbox.paypal.com/http" }
  }
}
```

The two servers are independent: PayPal's server authenticates with PayPal (follow PayPal's MCP
documentation for its current sign-in method) and acts on the merchant account, while MandatePay's
server only spends a shopper's money inside their mandates, through AgentGuard. Keep merchant
credentials away from shopping agents; MandatePay never receives PayPal MCP credentials.

## Limitations

- Only Demo Catalog products can be bought; Channel3 results are for comparison.
- Gateway rate limits and the 15-minute trusted-product memory are per API process (deploy one API
  replica or add a shared store before scaling).
- Tokens cannot be renamed or extended; revoke and create a new one.
- The browser config uses a placeholder path because the web app cannot know your local checkout.
- The MCP HTTP server is stateless: no server-initiated notifications or resumable streams.
