# Application architecture

```mermaid
flowchart TD
  User[User: intent and explicit permissions] --> Web[Next.js application and same-origin API proxy]
  Web --> API[Fastify: session ownership and validation]
  API --> AI[Configured OpenAI-compatible text model]
  AI --> Tools[Limited server-owned discovery and proposal tools]
  Tools --> Catalog[Channel3 discovery or labeled Demo Catalog]
  Catalog --> Proposal[Fresh validated purchase proposal]
  Proposal --> Guard[Deterministic AgentGuard]
  Guard -->|BLOCK| Audit[PostgreSQL immutable history and audit]
  Guard -->|REQUIRE_APPROVAL| Human[User reviews exact proposal]
  Guard -->|ALLOW| Revalidate[Atomic reservation and payment revalidation]
  Human --> Revalidate
  Revalidate --> PayPal[Server-side PayPal Sandbox order and capture]
  PayPal --> Webhook[Signature-verified webhook inbox]
  Webhook --> Reconcile[Authoritative provider reconciliation]
  Worker[Verified-inbox recovery worker] --> Reconcile
  Reconcile --> Audit
  PayPal --> Audit
  Audit --> Dashboard[Owned AG Grid Control Center and audit detail]
  API --> Refund[Owned captured payment and explicit refund confirmation]
  Refund --> PayPal
```

The AI never receives credentials or unrestricted money movement. AgentGuard decisions, user approvals and PayPal outcomes are independent records. Payment and refund calls leave the database transaction only after an operation is claimed; retries use the stored operation identifiers. Unknown outcomes remain held. The recovery worker performs provider reads and reconciles previously verified events, without creating new financial operations.

The frontend uses the same warm design system across landing, auth, mandates, chat, approvals, checkout, orders and analytics. Dashboard totals use owned, confirmed financial data; loaded-row charts disclose their pagination scope. Order links use payment IDs; proposals without a payment have their own policy/audit detail route.

Deployment is optional and currently deferred. The Render template uses a scheduled recovery job. Render Workflows, AG Studio's Agent Framework, Vault, voice and recurring purchases are separate unimplemented integrations, not substitutes for the working local MVP.
