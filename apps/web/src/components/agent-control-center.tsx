"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
  type ICellRendererParams,
  type ValueFormatterParams,
  type ValueGetterParams,
} from "ag-grid-community";
import { LoaderCircle, RefreshCcw, Search, X } from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { formatUsdLabel, parseUsdDecimal } from "@/lib/mandates/money";
import { capturedSpendByCategory, decisionCounts } from "@/lib/analytics/chart-math";
import {
  getDashboardSummary,
  getDashboardTransactions,
  getPolicyEvents,
  queryDashboard,
} from "@/lib/analytics/client";
import type {
  DashboardFilters,
  DashboardTotals,
  PolicyEventRow,
  TransactionRow,
} from "@/lib/analytics/types";

const communityModules = [AllCommunityModule];
const warmTheme = themeQuartz.withParams({
  backgroundColor: "#FEFAF6",
  foregroundColor: "#1B140E",
  borderColor: "#E7E0D7",
  headerBackgroundColor: "#F3E7C9",
  headerTextColor: "#1B140E",
  oddRowBackgroundColor: "#FCF8F3",
  fontFamily: "var(--font-satoshi)",
  fontSize: "13px",
});

const emptyTotals: DashboardTotals = {
  purchases: 0,
  policyAllowed: 0,
  humanApproved: 0,
  blocked: 0,
  spendMinor: 0,
  refundsMinor: 0,
  activeMandates: 0,
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 16).replace("T", " ");
}

const CAPTURED_PAYMENT_STATUSES = new Set(["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"]);

type SpendBarRow = { label: string; amountMinor: number };

function capturedSpendByKey(
  rows: readonly TransactionRow[],
  getKey: (row: TransactionRow) => string,
): SpendBarRow[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row.capturedAt || !row.paypalStatus || !CAPTURED_PAYMENT_STATUSES.has(row.paypalStatus))
      continue;
    const key = getKey(row);
    totals.set(key, (totals.get(key) ?? 0) + row.amountMinor);
  }
  return [...totals.entries()]
    .map(([label, amountMinor]) => ({ label, amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor);
}

function dayKey(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toISOString().slice(0, 10);
}

function weekKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown week";
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  return `Week of ${date.toISOString().slice(0, 10)}`;
}

function refundStatus(value: string | null) {
  if (value === "REFUNDED") return "Refunded";
  if (value === "PARTIALLY_REFUNDED") return "Partial refund";
  return "—";
}

function transactionDetailHref(row: TransactionRow) {
  return row.paymentId
    ? `/orders/${encodeURIComponent(row.paymentId)}`
    : `/proposals/${encodeURIComponent(row.id)}`;
}

const transactionColumns: ColDef<TransactionRow>[] = [
  {
    field: "activityAt",
    headerName: "Date",
    valueFormatter: ({ value }: ValueFormatterParams<TransactionRow>) =>
      formatDate(String(value ?? "")),
    minWidth: 150,
  },
  {
    field: "product.title",
    headerName: "Product",
    cellRenderer: ({ data }: ICellRendererParams<TransactionRow>) =>
      data ? (
        <Link
          href={transactionDetailHref(data)}
          className="font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label={`Open details for ${data.product.title}`}
        >
          {data.product.title}
        </Link>
      ) : (
        "—"
      ),
    minWidth: 190,
    flex: 1,
  },
  {
    field: "mandate.title",
    headerName: "Mandate",
    valueGetter: ({ data }: ValueGetterParams<TransactionRow>) =>
      data ? `${data.mandate.title} · v${data.mandate.version}` : "—",
    minWidth: 180,
  },
  { field: "merchant", headerName: "Merchant", minWidth: 140 },
  {
    field: "amountMinor",
    headerName: "Amount",
    valueFormatter: ({ value }: ValueFormatterParams<TransactionRow>) =>
      formatUsdLabel(Number(value)),
    minWidth: 110,
  },
  { field: "decision", headerName: "Decision", minWidth: 140 },
  { field: "approvalType", headerName: "Approval", minWidth: 140 },
  { field: "paypalStatus", headerName: "Payment", minWidth: 150 },
  {
    field: "paypalStatus",
    headerName: "Refund",
    valueFormatter: ({ value }: ValueFormatterParams<TransactionRow>) =>
      refundStatus(typeof value === "string" ? value : null),
    minWidth: 130,
  },
];

const policyColumns: ColDef<PolicyEventRow>[] = [
  {
    field: "createdAt",
    headerName: "Date",
    valueFormatter: ({ value }: ValueFormatterParams<PolicyEventRow>) =>
      formatDate(String(value ?? "")),
    minWidth: 150,
  },
  {
    field: "product.title",
    headerName: "Product",
    cellRenderer: ({ data }: ICellRendererParams<PolicyEventRow>) =>
      data ? (
        <Link
          href={`/proposals/${encodeURIComponent(data.proposalId)}`}
          className="font-medium underline-offset-4 hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {data.product.title}
        </Link>
      ) : (
        "—"
      ),
    flex: 1,
    minWidth: 190,
  },
  {
    field: "product.merchant",
    headerName: "Merchant",
    valueGetter: ({ data }: ValueGetterParams<PolicyEventRow>) => data?.product.merchant,
    minWidth: 140,
  },
  {
    field: "reasonCodes",
    headerName: "Reason codes",
    valueFormatter: ({ value }: ValueFormatterParams<PolicyEventRow>) =>
      Array.isArray(value) ? value.join(", ") : "—",
    flex: 1,
    minWidth: 220,
  },
  {
    field: "mandate.version",
    headerName: "Mandate",
    valueGetter: ({ data }: ValueGetterParams<PolicyEventRow>) =>
      data ? `${data.mandate.title} · v${data.mandate.version}` : "—",
    minWidth: 170,
  },
];

function filtersFromQuery(value: Record<string, unknown>): DashboardFilters {
  const filters: DashboardFilters = {};
  if (typeof value.minimumAmountMinor === "number")
    filters.minAmountMinor = value.minimumAmountMinor;
  if (value.minimumAmountOperator === "gt" || value.minimumAmountOperator === "gte") {
    filters.minAmountExclusive = value.minimumAmountOperator === "gt";
  }
  if (typeof value.maximumAmountMinor === "number")
    filters.maxAmountMinor = value.maximumAmountMinor;
  if (value.maximumAmountOperator === "lt" || value.maximumAmountOperator === "lte") {
    filters.maxAmountExclusive = value.maximumAmountOperator === "lt";
  }
  if (typeof value.decision === "string") filters.decision = value.decision;
  if (typeof value.category === "string") filters.category = value.category;
  if (typeof value.since === "string") filters.since = value.since;
  if (typeof value.until === "string") filters.until = value.until;
  return filters;
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-3 font-editorial text-3xl tracking-[-0.025em]">{value}</p>
      {detail ? <p className="mt-2 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function MiniBars({
  title,
  rows,
  valueLabel,
  description,
}: {
  title: string;
  rows: { label: string; amountMinor?: number; count?: number }[];
  valueLabel: (row: { amountMinor?: number; count?: number }) => string;
  description?: string;
}) {
  const max = Math.max(1, ...rows.map((row) => row.amountMinor ?? row.count ?? 0));
  return (
    <section className="rounded-2xl border border-border bg-card p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="font-editorial text-2xl tracking-[-0.02em]">{title}</h2>
        {description ? (
          <p className="text-right text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {rows.length ? (
        <div className="mt-6 space-y-4">
          {rows.map((row) => {
            const value = row.amountMinor ?? row.count ?? 0;
            return (
              <div key={row.label}>
                <div className="flex justify-between gap-4 text-xs">
                  <span className="truncate">{row.label}</span>
                  <span className="tabular-nums text-muted-foreground">{valueLabel(row)}</span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-secondary">
                  <div
                    className="h-2 rounded-full bg-primary"
                    style={{ width: `${Math.max(4, (value / max) * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">No verified data in this view.</p>
      )}
    </section>
  );
}

export function AgentControlCenter() {
  const [totals, setTotals] = useState<DashboardTotals>(emptyTotals);
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [policyEvents, setPolicyEvents] = useState<PolicyEventRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [clarification, setClarification] = useState<string | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [filters, setFilters] = useState<DashboardFilters>({});
  const [chartIntent, setChartIntent] = useState<"table" | "category" | "decisions" | null>(null);
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [decision, setDecision] = useState("");
  const [category, setCategory] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summary, transactionPage, policy] = await Promise.all([
        getDashboardSummary(),
        getDashboardTransactions({ limit: 50 }),
        getPolicyEvents(),
      ]);
      setTotals(summary);
      setTransactions(transactionPage.transactions);
      setNextCursor(transactionPage.nextCursor);
      setPolicyEvents(policy);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The control center could not load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function applyFilters() {
    setError(null);
    try {
      const next: DashboardFilters = {};
      if (minAmount.trim()) next.minAmountMinor = parseUsdDecimal(minAmount);
      if (maxAmount.trim()) next.maxAmountMinor = parseUsdDecimal(maxAmount);
      if (decision) next.decision = decision;
      if (category.trim()) next.category = category.trim();
      const page = await getDashboardTransactions({ ...next, limit: 50 });
      setFilters(next);
      setChartIntent(null);
      setTransactions(page.transactions);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The transaction filters could not be applied.",
      );
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getDashboardTransactions({ ...filters, cursor: nextCursor, limit: 50 });
      setTransactions((current) => [...current, ...page.transactions]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The next transaction page could not load.",
      );
    } finally {
      setLoadingMore(false);
    }
  }

  async function runQuery() {
    if (!query.trim() || queryLoading) return;
    setQueryLoading(true);
    setError(null);
    setClarification(null);
    try {
      const result = await queryDashboard(query.trim());
      if (result.status === "needs_clarification") {
        setClarification(result.clarification);
      } else {
        const nextFilters = filtersFromQuery(result.filters);
        setFilters(nextFilters);
        setMinAmount(
          nextFilters.minAmountMinor === undefined
            ? ""
            : formatUsdLabel(nextFilters.minAmountMinor).replace("$", ""),
        );
        setMaxAmount(
          nextFilters.maxAmountMinor === undefined
            ? ""
            : formatUsdLabel(nextFilters.maxAmountMinor).replace("$", ""),
        );
        setDecision(nextFilters.decision ?? "");
        setCategory(nextFilters.category ?? "");
        setChartIntent(
          result.filters.chart === "category" ||
            result.filters.chart === "decisions" ||
            result.filters.chart === "table"
            ? result.filters.chart
            : null,
        );
        setTransactions(result.transactions);
        setNextCursor(result.nextCursor);
        setClarification(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The dashboard query could not run.");
    } finally {
      setQueryLoading(false);
    }
  }

  function resetFilters() {
    setMinAmount("");
    setMaxAmount("");
    setDecision("");
    setCategory("");
    setFilters({});
    setChartIntent(null);
    setQuery("");
    setClarification(null);
    void load();
  }

  const spendByCategory = capturedSpendByCategory(transactions);
  const decisions = decisionCounts(transactions);
  const spendByMandate = capturedSpendByKey(
    transactions,
    (row) => `${row.mandate.title} · v${row.mandate.version}`,
  );
  const spendByDay = capturedSpendByKey(transactions, (row) => dayKey(row.capturedAt!));
  const spendByWeek = capturedSpendByKey(transactions, (row) => weekKey(row.capturedAt!));
  const scopeLabel = nextCursor
    ? `Loaded rows only · ${transactions.length} shown · more data available`
    : `Loaded rows only · ${transactions.length} shown`;
  const chartScope = nextCursor ? "Loaded rows · load more for more" : "Loaded rows";
  const filterLabels = [
    filters.minAmountMinor !== undefined
      ? `${filters.minAmountExclusive ? ">" : ">="} ${formatUsdLabel(filters.minAmountMinor)}`
      : null,
    filters.maxAmountMinor !== undefined
      ? `${filters.maxAmountExclusive ? "<" : "<="} ${formatUsdLabel(filters.maxAmountMinor)}`
      : null,
    filters.decision ? `Decision ${filters.decision}` : null,
    filters.category ? `Category ${filters.category}` : null,
    filters.since ? `Since ${formatDate(filters.since)}` : null,
    filters.until ? `Until ${formatDate(filters.until)}` : null,
  ].filter(Boolean) as string[];

  if (loading)
    return (
      <div
        className="flex min-h-64 items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle size={18} className="mr-2 animate-spin" aria-hidden="true" /> Loading verified
        control-center data…
      </div>
    );
  if (error && !transactions.length && !policyEvents.length)
    return (
      <div
        className="rounded-2xl border border-destructive/20 bg-destructive/8 p-6 text-sm"
        role="alert"
      >
        <p>{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-4 inline-flex min-h-11 items-center gap-2 font-medium underline underline-offset-4"
        >
          <RefreshCcw size={14} aria-hidden="true" /> Try again
        </button>
      </div>
    );

  return (
    <AgGridProvider modules={communityModules}>
      <div className="space-y-7">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Captured purchases"
            value={String(totals.purchases)}
            detail="Verified payment records"
          />
          <Metric
            label="Captured spend"
            value={formatUsdLabel(totals.spendMinor)}
            detail="Completed or settled payments"
          />
          <Metric
            label="Blocked attempts"
            value={String(totals.blocked)}
            detail="Prevented by AgentGuard"
          />
          <Metric label="Active mandates" value={String(totals.activeMandates)} />
        </div>
        <section className="rounded-2xl border border-border bg-card p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-editorial text-2xl tracking-[-0.02em]">Ask the control center</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Queries filter the same owned transaction data shown below.
              </p>
            </div>
            <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
              Read-only analytics
            </span>
          </div>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void runQuery();
              }}
              placeholder="Show blocked transactions this week"
              className="h-11 flex-1 rounded-xl border border-border bg-background px-3 text-sm outline-hidden focus:border-foreground/45 focus:ring-4 focus:ring-foreground/8"
            />
            <button
              type="button"
              onClick={() => void runQuery()}
              disabled={queryLoading || !query.trim()}
              className={cn(buttonVariants({ size: "sm" }))}
            >
              {queryLoading ? (
                <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
              ) : (
                <Search size={15} aria-hidden="true" />
              )}{" "}
              Ask
            </button>
          </div>
          {clarification ? (
            <p
              className="mt-4 rounded-xl border border-border bg-secondary px-4 py-3 text-sm"
              role="status"
            >
              {clarification}
            </p>
          ) : null}
        </section>
        <section className="rounded-2xl border border-border bg-card p-5 sm:p-7">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-editorial text-2xl tracking-[-0.02em]">Transactions</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {scopeLabel} · captured spend is calculated from verified payment status.
              </p>
            </div>
            <button
              type="button"
              onClick={resetFilters}
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            >
              <X size={14} aria-hidden="true" /> Reset filters
            </button>
          </div>
          {filterLabels.length ? (
            <div className="mt-4 flex flex-wrap gap-2 text-xs" aria-label="Applied filters">
              {filterLabels.map((label) => (
                <span key={label} className="rounded-full bg-sand px-2.5 py-1">
                  {label}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input
              value={minAmount}
              onChange={(event) => setMinAmount(event.currentTarget.value)}
              placeholder="Min amount USD"
              inputMode="decimal"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-hidden focus:border-foreground/45 focus:ring-4 focus:ring-foreground/8"
            />
            <input
              value={maxAmount}
              onChange={(event) => setMaxAmount(event.currentTarget.value)}
              placeholder="Max amount USD"
              inputMode="decimal"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-hidden focus:border-foreground/45 focus:ring-4 focus:ring-foreground/8"
            />
            <select
              value={decision}
              onChange={(event) => setDecision(event.currentTarget.value)}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-hidden focus:border-foreground/45 focus:ring-4 focus:ring-foreground/8"
            >
              <option value="">All decisions</option>
              <option value="ALLOW">ALLOW</option>
              <option value="REQUIRE_APPROVAL">REQUIRE_APPROVAL</option>
              <option value="BLOCK">BLOCK</option>
            </select>
            <div className="flex gap-2">
              <input
                value={category}
                onChange={(event) => setCategory(event.currentTarget.value)}
                placeholder="Category"
                className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-sm outline-hidden focus:border-foreground/45 focus:ring-4 focus:ring-foreground/8"
              />
              <button
                type="button"
                onClick={() => void applyFilters()}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                Apply
              </button>
            </div>
          </div>
          {error ? (
            <p className="mt-4 text-sm text-foreground" role="alert">
              {error}
            </p>
          ) : null}
          <div
            className="ag-theme-quartz mt-6 w-full overflow-hidden rounded-xl"
            style={{ minHeight: transactions.length ? 360 : 150 }}
          >
            <AgGridReact<TransactionRow>
              theme={warmTheme}
              rowData={transactions}
              columnDefs={transactionColumns}
              getRowId={({ data }: GetRowIdParams<TransactionRow>) => data.id}
              domLayout="autoHeight"
              pagination={false}
              suppressCellFocus={false}
            />
          </div>
          {nextCursor ? (
            <div className="mt-5 flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                {loadingMore ? (
                  <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                ) : null}
                {loadingMore ? "Loading…" : "Load more transactions"}
              </button>
            </div>
          ) : null}
        </section>
        {chartIntent === "table" ? (
          <section className="rounded-2xl border border-border bg-secondary p-5 text-sm text-muted-foreground">
            The query requested the transaction table only. Ask for category or decision analysis to
            show a chart.
          </section>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            {chartIntent === null ? (
              <>
                <MiniBars
                  title="Spend by mandate"
                  rows={spendByMandate}
                  valueLabel={(row) => formatUsdLabel(row.amountMinor)}
                  description={chartScope}
                />
                <MiniBars
                  title="Spend by day"
                  rows={spendByDay}
                  valueLabel={(row) => formatUsdLabel(row.amountMinor)}
                  description={chartScope}
                />
                <MiniBars
                  title="Spend by week"
                  rows={spendByWeek}
                  valueLabel={(row) => formatUsdLabel(row.amountMinor)}
                  description={chartScope}
                />
              </>
            ) : null}
            {chartIntent !== "decisions" && chartIntent !== null ? (
              <MiniBars
                title="Captured spend by category"
                rows={spendByCategory}
                valueLabel={(row) => formatUsdLabel(row.amountMinor)}
                description={chartScope}
              />
            ) : null}
            {chartIntent !== "category" && chartIntent !== null ? (
              <MiniBars
                title="Decision breakdown"
                rows={decisions}
                valueLabel={(row) => String(row.count ?? 0)}
                description={chartScope}
              />
            ) : null}
          </div>
        )}
        <section className="rounded-2xl border border-border bg-card p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-editorial text-2xl tracking-[-0.02em]">Policy violations</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Blocked proposal decisions returned by AgentGuard.
              </p>
            </div>
            <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
              {policyEvents.length} events
            </span>
          </div>
          <div
            className="ag-theme-quartz mt-6 w-full overflow-hidden rounded-xl"
            style={{ minHeight: policyEvents.length ? 300 : 150 }}
          >
            <AgGridReact<PolicyEventRow>
              theme={warmTheme}
              rowData={policyEvents}
              columnDefs={policyColumns}
              getRowId={({ data }: GetRowIdParams<PolicyEventRow>) => data.id}
              domLayout="autoHeight"
              pagination={false}
              suppressCellFocus={false}
            />
          </div>
        </section>
      </div>
    </AgGridProvider>
  );
}
