import { PageHeader } from "@/components/admin/page-header";
import { CollectionView } from "@/components/admin/collection-view";
import { readTableQuery } from "@/lib/table-query";
import { adminApi } from "@/lib/admin-fetch";
import { resourceSpecs } from "@/lib/resource-specs";
import type { TableState } from "@/components/admin/data-table";
import {
  parseAdminList,
  parseAdminUser,
  parseAdminMandate,
  parseAdminProposal,
  parseAdminApproval,
  parseAdminOrder,
  parseAdminPayment,
  parseAdminRefund,
  parseAdminWebhook,
  parseAdminAuditEvent,
} from "@mandatepay/shared";

const descriptions: Record<keyof typeof resourceSpecs, string> = {
  users:
    "Inspect accounts, verification, autonomy and observed activity. Disablement is not available yet.",
  mandates:
    "Inspect canonical permissions, validity and related proposals. Original prompts are not shown.",
  proposals:
    "Inspect AgentGuard decisions, product snapshots and checkout eligibility without executing payment.",
  approvals:
    "Inspect human approval records. Administrators cannot approve purchases on a user's behalf.",
  orders: "Orders are payment records that have a PayPal order identifier.",
  payments:
    "Inspect capture, refund and reconciliation diagnostics. Provider payloads are not exposed.",
  refunds: "Inspect refunds. Completing a refund does not restore gross spending permission.",
  webhooks: "Inspect verified inbox diagnostics. Raw provider payloads are not shown.",
  audit: "Immutable administrator audit events. These records cannot be edited or deleted.",
};

export async function OperationsCollection({
  resource,
  searchParams,
}: {
  resource: keyof typeof resourceSpecs;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const config = resourceSpecs[resource];
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams))
    if (value !== undefined)
      for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  const query = readTableQuery(params, config.spec);
  const response = query.error
    ? null
    : await adminApi(`/api/admin/${resource}${params.size ? `?${params}` : ""}`);
  const parsed = response ? parseList(resource, response.json) : null;
  const state: TableState<Record<string, unknown> & { id: string }> = query.error
    ? { status: "error", description: query.error }
    : !response || response.status >= 400 || !parsed
      ? { status: "error", description: "This list could not be loaded. Try again shortly." }
      : {
          status: "ready",
          data: parsed.data as Array<Record<string, unknown> & { id: string }>,
          page: parsed.page,
        };
  return (
    <>
      <PageHeader
        title={config.caption}
        description={descriptions[resource]}
        breadcrumbs={[{ label: "Overview", href: "/" }, { label: config.caption }]}
      />
      <CollectionView resource={resource} state={state} />
    </>
  );
}

function parseList(resource: keyof typeof resourceSpecs, json: unknown) {
  switch (resource) {
    case "users":
      return parseAdminList(json, parseAdminUser);
    case "mandates":
      return parseAdminList(json, parseAdminMandate);
    case "proposals":
      return parseAdminList(json, parseAdminProposal);
    case "approvals":
      return parseAdminList(json, parseAdminApproval);
    case "orders":
      return parseAdminList(json, parseAdminOrder);
    case "payments":
      return parseAdminList(json, parseAdminPayment);
    case "refunds":
      return parseAdminList(json, parseAdminRefund);
    case "webhooks":
      return parseAdminList(json, parseAdminWebhook);
    case "audit":
      return parseAdminList(json, parseAdminAuditEvent);
  }
}
