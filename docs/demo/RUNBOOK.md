# Functional demo runbook

Use the README to install pinned dependencies, start isolated PostgreSQL, apply migrations and configure the model. Keep provider keys server-side. `pnpm test:e2e` runs the actual application against an explicit fake AI/PayPal transport and isolated database, covering human approval, capture, refunds, chat and analytics. This demonstrates working code and is not evidence of live Sandbox execution.

## Manual product demonstration

1. Open the landing page and choose Explore MandatePay. Sign up and create a mandate: Sony/Bose headphones, new only, $180 maximum, $150 autonomous limit, quantity one, valid 24 hours. Review the canonical permissions before saving and explicitly activating.
2. Open Chat, select the correct mandate, and request headphones. Review the actual proposal's AgentGuard reasons separately from the AI explanation. Standard PayPal checkout still requires payer consent even if policy returns ALLOW.
3. Use structured discovery if the model cannot select the intended demo scenario. The controlled catalog contains new Sony items at $139/$169, refurbished Bose at $120 and office paper at $27. Prices are illustrative demo merchant facts. The global autonomy switch defaults off, and a new merchant can require approval even below the automatic threshold. Never present these additional approval reasons as a bug or hide them for the demo.
4. Show the $169 approval case and the refurbished-condition block. A human cannot approve a hard policy violation. Approval itself does not capture payment.
5. When live Sandbox verification is resumed, use a separate personal Sandbox buyer, complete approval, capture the exact local payment record and show its provider ID plus verified webhook history. Do not replace this step with an invented success notification.
6. Ask Chat to refund $20 of the headphone purchase. It finds an owned captured transaction and prepares a draft. Open Review refund, inspect the prefilled amount/reason and confirm explicitly. Show remaining full refund with a separate request key and actual provider result.
7. Open Control Center. Ask “Show purchases above $100” and “Show everything AgentGuard blocked this week.” Show active filters, loaded-row chart scope, exact policy reasons and record drilldown. Gross captured spend is not restored by refunds.

## Three-minute presentation outline

| Time      | Demonstration                                                         |
| --------- | --------------------------------------------------------------------- |
| 0:00–0:20 | AI can recommend products; permission to spend needs explicit limits. |
| 0:20–0:45 | Create and review a purchase mandate.                                 |
| 0:45–1:15 | Product selection and deterministic approval/block reasons.           |
| 1:15–1:50 | Human approval and qualified Sandbox checkout/capture.                |
| 1:50–2:15 | Conversational refund draft and explicit refund confirmation.         |
| 2:15–2:45 | Owned dashboard query and complete audit chain.                       |
| 2:45–3:00 | AI proposes. AgentGuard authorizes. PayPal executes.                  |

## Evidence and submission

Before recording the final video, qualify the real Sandbox flow and label any simulated clip visibly. Record the hosted or locally runnable build, not only a mockup. Keep secrets, private buyer details and browser tokens out of footage. Include the public repository, root MIT license, complete setup instructions, architecture diagram and actual tool-usage record. Do not claim integrations that remain optional/unimplemented. Hosted acceptance, final video and hackathon submission have not been completed.
