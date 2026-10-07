import Link from "next/link";
import { PageHeader } from "@/components/admin/page-header";
import { DefinitionList } from "@/components/admin/definition-list";
import { EntityLink } from "@/components/admin/entity-link";
import { EmptyState } from "@/components/admin/states";
import { OutcomeBadge, ParseAlert, errorClassLabel } from "@/components/admin/health-card";
import { formatUtcDate } from "@/components/admin/timeline";
import { adminApi } from "@/lib/admin-fetch";
import { parseAdminAgentRun, parseAdminDetail } from "@mandatepay/shared";

export default async function AgentRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const response = await adminApi(`/api/admin/agent/runs/${encodeURIComponent(id)}`);
  const detail = parseAdminDetail(response.json, parseAdminAgentRun);
  const breadcrumbs = [
    { label: "Overview", href: "/" },
    { label: "Agent activity", href: "/agent" },
    { label: detail ? detail.data.id : "Run" },
  ];
  if (response.status === 404) {
    return (
      <>
        <PageHeader
          title="Agent run"
          description="This run is not in the operational record."
          breadcrumbs={breadcrumbs}
        />
        <p role="alert" className="text-sm">
          This agent run was not found.
        </p>
        <Link
          href="/agent"
          className="mt-4 inline-flex min-h-11 items-center rounded-xl border px-4 text-sm"
        >
          Back to agent activity
        </Link>
      </>
    );
  }
  if (!detail) {
    return (
      <>
        <PageHeader
          title="Agent run"
          description="Operational detail for one shopping-agent run."
          breadcrumbs={breadcrumbs}
        />
        <ParseAlert
          message="This agent run could not be loaded."
          href={`/agent/runs/${encodeURIComponent(id)}`}
        />
      </>
    );
  }
  const run = detail.data;
  return (
    <>
      <PageHeader
        title="Agent run"
        description="Timing, outcome, and tool names for this run."
        breadcrumbs={breadcrumbs}
      />
      <DefinitionList
        items={[
          { label: "Run", value: run.id },
          { label: "Request", value: run.requestId },
          { label: "User", value: <EntityLink resource="users" id={run.userId} /> },
          { label: "Model", value: run.modelId },
          { label: "Started", value: formatUtcDate(run.startedAt) },
          {
            label: "Completed",
            value: run.completedAt ? formatUtcDate(run.completedAt) : "—",
          },
          { label: "Duration", value: run.durationMs === null ? "—" : `${run.durationMs} ms` },
          { label: "Outcome", value: <OutcomeBadge outcome={run.outcome} /> },
          { label: "Error class", value: errorClassLabel(run.errorClass) },
          {
            label: "Proposal",
            value: run.proposalId ? <EntityLink resource="proposals" id={run.proposalId} /> : "—",
          },
          {
            label: "Refund draft payment",
            value: run.refundDraftId ? (
              <EntityLink resource="payments" id={run.refundDraftId} label="Refund draft payment" />
            ) : (
              "—"
            ),
          },
        ]}
      />
      <section aria-label="Tool calls" className="mt-8">
        <h2 className="mb-4 text-lg font-medium">Tool calls</h2>
        {run.tools.length === 0 ? (
          <EmptyState title="No tool calls" description="This run did not record any tool calls." />
        ) : (
          <div className="overflow-x-auto rounded-2xl border bg-card">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <caption className="sr-only">Tool calls</caption>
              <thead className="border-b text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Outcome
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Error class
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Duration
                  </th>
                </tr>
              </thead>
              <tbody>
                {run.tools.map((tool, index) => (
                  <tr
                    key={`${tool.name}-${tool.startedAt}-${index}`}
                    className="border-b last:border-b-0"
                  >
                    <td className="px-4 py-3">{tool.name}</td>
                    <td className="px-4 py-3">
                      <OutcomeBadge outcome={tool.outcome} />
                    </td>
                    <td className="px-4 py-3">{errorClassLabel(tool.errorClass)}</td>
                    <td className="px-4 py-3">
                      {tool.durationMs === null ? "—" : `${tool.durationMs} ms`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
