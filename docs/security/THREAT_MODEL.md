# MandatePay threat model

## Trust boundaries

The browser and model can submit intent but cannot set user identity, product prices, merchant bindings, currency, approval state or PayPal credentials. The authenticated API retrieves owned records, refreshes controlled catalog facts and constructs totals in integer cents. AgentGuard is deterministic and runs again immediately before payment. Only server-side PayPal calls can execute financial operations.

Product text and model explanations are untrusted. The shopping agent has seven allow-listed discovery/proposal/refund-draft tools. It has no payment, approval, capture or refund-execution tool. Strict schemas reject unknown arguments, invented product IDs and financial authority. Bounded rounds, timeouts, token budgets and rate limits constrain resource use. Explanations are labeled as non-authoritative; actual policy and payment state have separate UI.

## Controls and failure handling

| Threat                                 | Implemented control                                                                                                               | Remaining qualification                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Cross-user purchases or refunds        | Session-derived ownership on every financial read/write; no caller-supplied user ID                                               | Hosted session and multi-user acceptance                                   |
| Forged or changed mandate permissions  | Versioned canonical snapshots, explicit activation, pause/revoke, deterministic revalidation                                      | Preserve these checks for every future tool                                |
| Concurrent overspending                | User/mandate/proposal/payment locks and atomic reservations; active holds included in allowance                                   | Multi-replica load qualification                                           |
| Double payment after retry             | Stable server-stored PayPal request IDs; state transitions and exact provider bindings                                            | Real Sandbox failure/retry evidence                                        |
| Ambiguous provider outcomes            | Hold reservations; reconcile existing provider IDs; no timeout-based approval or release                                          | Operational alerting and manual incident procedure                         |
| Forged webhook                         | Signature verification before inbox write; authoritative order/capture/refund lookup                                              | Real registered HTTPS delivery                                             |
| Lost or delayed webhook processing     | Verified-only replay worker, leases, dedupe, backoff and bounded attempts                                                         | Deployed scheduler and exhausted-event alerts                              |
| Refund exceeds remaining amount        | Owned capture, explicit confirmation, active refund reservations and full/partial amount validation                               | Live partial/full refund qualification                                     |
| Credential exposure                    | Scoped server env loader, fixed provider endpoints, redacted generic errors; auth URL queries omitted from API logs               | Review infrastructure access/log retention before release                  |
| Account takeover                       | Better Auth secure production cookies, CSRF/origin checks, production email verification, single-use reset and session revocation | Verified sender delivery in the hosted environment                         |
| Resource abuse                         | Auth/AI and authenticated financial mutation limits, request/schema bounds                                                        | Limits are per-process; shared limiting required before horizontal scaling |
| Clickjacking or token referrer leakage | Frame denial, no-referrer policy and content-type protection on web responses                                                     | Hosted security-header verification                                        |

## Audit and operational boundaries

Mandate versions, policy decisions, approvals, financial state changes and refunds produce persisted audit records. API DTOs expose bounded, allowed audit facts rather than raw provider credentials or payloads. Captured gross spending continues to count after refunds. UTC periods use Monday-start weeks. Sample records never count as actual completed financial activity.

Public production authentication requires HTTPS, a strong auth secret, PostgreSQL, verified-email delivery and an approved sender. Development/test mode intentionally permits immediate signup for local demonstrations. PayPal is Sandbox-only. No card number, CVV or PayPal password is stored. Vault/off-session authority is not implemented. A production deployment additionally needs backups, monitored recovery, privacy/retention policy, live provider qualification and incident ownership; passing local tests alone does not establish those properties.
