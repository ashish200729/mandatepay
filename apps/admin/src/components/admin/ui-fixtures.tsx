"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { parseAdminAuditEvent } from "@mandatepay/shared";
import { Button } from "@mandatepay/ui/components/button";
import { useTableQuery } from "@/lib/use-table-query";
import { fixtureSpec, type FixtureRow } from "@/lib/ui-fixture-data";
import { PageHeader } from "./page-header";
import { MetricCard } from "./metric-card";
import { StatusBadge, HealthIndicator } from "./status-badge";
import { DataTable, type TableState } from "./data-table";
import { FilterBar } from "./filters";
import {
  ConfirmDialog,
  ReasonDialog,
  DangerConfirmDialog,
  type ActionConfirmation,
} from "./action-dialogs";
import { AuditTimeline } from "./timeline";

const event = parseAdminAuditEvent({
  id: "11111111-1111-4111-8111-111111111111",
  actorAdminId: null,
  actorUserId: null,
  role: null,
  action: "ADMIN_LOGIN_FAILED",
  targetType: "ADMIN_AUTH",
  targetId: "main",
  reason: "Synthetic credential rejection.",
  requestId: "11111111-1111-4111-8111-111111111111",
  correlationId: "11111111-1111-4111-8111-111111111111",
  actionId: null,
  beforeSummaryJson: null,
  afterSummaryJson: { token: "fixture-secret-must-not-render" },
  result: "FAILURE",
  errorCode: "ADMIN_SIGN_IN_REJECTED",
  createdAt: "2026-10-05T12:00:00.000Z",
})!;
export function UiFixtures({ state }: { state: TableState<FixtureRow> }) {
  const router = useRouter(),
    navigation = useTableQuery(fixtureSpec);
  const [mode, setMode] = useState("ready"),
    [outcome, setOutcome] = useState("success");
  const [confirm, setConfirm] = useState(false),
    [reason, setReason] = useState(false),
    [danger, setDanger] = useState(false);
  const [attempts, setAttempts] = useState<ActionConfirmation[]>([]);
  async function run(input: ActionConfirmation): Promise<{ status: "success" | "pending" }> {
    setAttempts((current) => [...current, input]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (outcome === "error") throw new Error("fixture-provider-secret-must-not-render");
    return { status: outcome === "pending" ? "pending" : "success" };
  }
  const common = {
    target: { id: "fixture-1", label: "Synthetic record" },
    actionLabel: "Run sample action",
    onConfirm: run,
  };
  const displayed: TableState<FixtureRow> =
    mode === "loading"
      ? { status: "loading" }
      : mode === "error"
        ? { status: "error" }
        : mode === "empty"
          ? { status: "ready", data: [], page: { limit: navigation.query.limit, nextCursor: null } }
          : state;
  return (
    <>
      <PageHeader
        title="UI fixtures"
        description="Synthetic records for UI testing. No business actions run. This route is unavailable outside the loopback test host."
        breadcrumbs={[{ label: "My Session", href: "/session" }, { label: "UI fixtures" }]}
      />
      <div className="mb-7 grid gap-4 sm:grid-cols-2">
        <MetricCard label="Sample records" value={6} description="Synthetic data only." />
        <MetricCard
          label="Unavailable metric"
          value={null}
          availability="unavailable"
          description="Missing data is never reported as zero."
        />
      </div>
      <FilterBar
        navigation={navigation}
        search={{ label: "Search sample records" }}
        filters={[
          {
            key: "status",
            label: "Result",
            options: [
              { value: "SUCCESS", label: "Success" },
              { value: "FAILURE", label: "Failure" },
            ],
          },
        ]}
        dates
      />
      <div aria-label="Simulated table states" className="mb-4 flex flex-wrap gap-2">
        {["ready", "loading", "empty", "error"].map((value) => (
          <Button key={value} variant="outline" onClick={() => setMode(value)}>
            Show {value}
          </Button>
        ))}
      </div>
      <DataTable
        caption="Sample records"
        state={displayed}
        columns={[
          { key: "name", label: "Name", sortKey: "name", render: (row) => row.name },
          { key: "status", label: "Result", render: (row) => <StatusBadge status={row.status} /> },
          {
            key: "createdAt",
            label: "Created · UTC",
            sortKey: "createdAt",
            render: (row) => row.createdAt,
          },
        ]}
        getRowId={(row) => row.id}
        rowHref={(row) => `/ui-fixtures/${row.id}`}
        onRetry={() => {
          setMode("ready");
          router.refresh();
        }}
        onNext={navigation.next}
        onPrevious={navigation.previous}
        hasPrevious={navigation.hasPrevious}
        pending={navigation.pending}
        sort={{ key: navigation.query.sort ?? "createdAt", direction: navigation.query.direction }}
        onSort={navigation.sort}
      />
      <section aria-label="Sample action dialogs" className="my-8 rounded-2xl border bg-card p-6">
        <h2 className="text-lg font-medium">Dialog fixtures</h2>
        <label className="my-4 block text-sm">
          Simulated outcome
          <select
            aria-label="Simulated outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            className="ml-3 h-11 rounded-xl border px-3"
          >
            <option value="success">Success</option>
            <option value="pending">Pending</option>
            <option value="error">Unknown error</option>
          </select>
        </label>
        <div className="flex flex-wrap gap-3">
          <ConfirmDialog
            {...common}
            open={confirm}
            onOpenChange={setConfirm}
            title="Confirm sample action"
            description="A simple confirmation. This runs a local UI fixture only."
            trigger={<Button variant="outline">Open confirmation</Button>}
          />
          <ReasonDialog
            {...common}
            open={reason}
            onOpenChange={setReason}
            title="Reason for sample action"
            description="A required explanation. No operational data is changed."
            trigger={<Button variant="outline">Open reason dialog</Button>}
          />
          <DangerConfirmDialog
            {...common}
            open={danger}
            onOpenChange={setDanger}
            title="Review sensitive sample action"
            description="Requires fresh authentication, an exact target ID and final review. Password confirmation uses the session endpoint; sample actions run locally."
            freshAuthUntil="2020-01-01T00:00:00.000Z"
            trigger={<Button variant="outline">Open sensitive action</Button>}
          />
        </div>
        <p className="mt-4 text-sm">Sample submissions: {attempts.length}</p>
        <pre
          data-testid="sample-submissions"
          className="mt-3 block whitespace-pre-wrap break-all text-xs"
        >
          {JSON.stringify(attempts)}
        </pre>
      </section>
      <section aria-label="Sample timeline" className="rounded-2xl border bg-card p-6">
        <h2 className="mb-6 text-lg font-medium">Synthetic audit timeline</h2>
        <AuditTimeline events={[event]} />
        <div className="mt-5">
          <HealthIndicator status="unknown" />
        </div>
      </section>
    </>
  );
}
