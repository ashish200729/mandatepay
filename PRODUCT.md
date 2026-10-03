# MandatePay

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

User requested pnpm, Turborepo, Next.js, React, TypeScript, Node.js, Tailwind CSS, and shadcn/ui. Fastify is the chosen backend foundation.

## Users

Consumers, household managers, and business users who want to delegate shopping while retaining control over spending.

## Product Purpose

AI commerce with human-controlled spending permissions. AI proposes, AgentGuard authorizes, PayPal executes.

## Positioning

A deterministic permission layer between an AI purchase proposal and payment execution.

## Capabilities and Constraints

The user authorized phase-wise implementation in TypeScript/Node only. Authentication, PostgreSQL, reviewable/versioned mandates, discovery/comparison, deterministic purchase/refund policy, approvals, Sandbox payment services, verified webhook processing, audit and AG Grid Community analytics are implemented. The bounded shopping-agent API is wired; a full conversational frontend remains follow-up work. Automated financial tests use simulated providers, while live Sandbox buyer/capture/refund/webhook and hosting qualification remain open. Landing examples are illustrative; amounts use integer minor units. AgentGuard cannot be overridden by the LLM.

## Brand Commitments

MandatePay; AgentGuard Policy Engine. The approved Runable-inspired design uses serif headings, warm ivory backgrounds, sand panels and landscape imagery. This revision supersedes the initial neutral hex palette. The same theme applies across the application. Hedvig Letters Serif and Satoshi remain the chosen pairing; the Satoshi binary is ignored and obtained directly from Fontshare during setup. Preserve the approved identity and design as functionality is implemented.

## Evidence on Hand

The user's product brief supplies illustrative Sony/Bose headphones examples: $139 allowed, $169 requires approval, $220 blocked; maximum $180, automatic spending up to $150, new products only. No real transaction, customer, partnership, performance, or deployment evidence exists.

## Product Principles

- Human permissions define financial authority.
- AI recommendation, deterministic authorization, and financial execution stay separate.
- Explain rules and outcomes plainly.
- Scaffold first; integrate providers in later iterations.
