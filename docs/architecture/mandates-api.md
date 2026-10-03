# Authentication and mandate contracts

All protected requests resolve the owner from a database-backed session. User IDs in client input are not accepted. The web app uses its same-origin `/api` proxy; server credentials remain behind the API. Mutation routes require the configured trusted application origin.

## Routes

| Method/path                     | Contract                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| GET /health                     | Liveness only                                                                                                                  |
| GET /health/ready               | Database/auth readiness; 503 when unavailable                                                                                  |
| GET/POST /api/auth/*            | Better Auth session/signup/signin/signout handlers                                                                             |
| GET /api/me                     | Authenticated own user and autonomy setting                                                                                    |
| PATCH /api/settings             | Strict boolean autonomy input; default false; atomic update/audit                                                              |
| POST /api/mandates/parse        | Strict prompt input, 12,000-character maximum; authenticated, rate-limited; ready draft or clarification; no writes/activation |
| POST /api/mandates              | Reviewed canonical mandate + originalPrompt + optional requestKey; DRAFT only; idempotent creation                             |
| GET /api/mandates               | Own mandates only                                                                                                              |
| GET /api/mandates/:id           | Own detail or 404                                                                                                              |
| PATCH /api/mandates/:id         | Expected version + complete canonical rules; append immutable new version; stale version 409                                   |
| POST /api/mandates/:id/activate | Explicit activation of valid draft, expected version                                                                           |
| POST /api/mandates/:id/pause    | Suspend active mandate                                                                                                         |
| POST /api/mandates/:id/resume   | Resume paused mandate within validity                                                                                          |
| POST /api/mandates/:id/revoke   | Terminal revocation; history retained                                                                                          |

Money is safe integer USD cents, not floating dollar input. UI decimal strings convert through checked integer arithmetic. Timezone is UTC; weekly accounting starts Monday. Auto limit cannot exceed maximum transaction. Optional cumulative limits must be positive. Conditions and restrictions are strict schema values; unsupported rules are rejected rather than discarded.

## Review and retries

AI never activates a mandate. The user reviews editable canonical permissions, acknowledges that exact draft, saves it and explicitly activates it. Editing reviewed fields clears the acknowledgement and creates a fresh request key. Duplicate requests with the same owner/key/content return the original draft; changed payloads conflict. After a failed activation, retry the saved ID/version without creating another draft.

Original instructions are retained for audit context. Canonical versioned permissions are the authorization source of truth. Invalid stored canonical rules fail closed rather than being replaced with broader inferred defaults.

## Errors and edge cases

- Anonymous: 401; another owner's mandate: 404.
- Untrusted mutation origin: 403.
- Invalid schema, money, date ranges or extra fields: 400.
- Stale version, invalid state, revoked/expired activation: 409.
- Parser/provider missing, unsupported structured output or outage: redacted 503.
- Parse rate exceeded: 429 with Retry-After.
- Missing database/auth: 503; the UI distinguishes service outage from expired login.
- Browser states cover pending/disabled actions, clarification, empty list, retry, stale-version reload and inline revoke confirmation.

## Qualification

See the phase ledger for current test commands/results. Browser tests use the real API/database and an explicit isolated HTTP model fixture. Sarvam live parsing is separate. These contracts do not authorize a PayPal operation; purchase/payment routes must separately enforce AgentGuard, reservations, approval binding, provider idempotency and webhook verification.
