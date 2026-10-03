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
import {
  ArrowLeftRight,
  ArrowUpRight,
  BarChart3,
  LoaderCircle,
  RefreshCcw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
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
  backgroundColor: "#FFFFFF",
  foregroundColor: "#1B140E",
  borderColor: "#E7E0D7",
  headerBackgroundColor: "#F8F1EB",
  headerTextColor: "#1B140E",
  oddRowBackgroundColor: "#FEFAF6",
  fontFamily: "var(--font-satoshi)",
  fontSize: "13px",
  headerFontSize: "12px",
  headerFontWeight: 500,
  rowHeight: 56,
  headerHeight: 44,
  wrapperBorderRadius: 12,
  cellHorizontalPadding: 16,
});

const fieldClass =
  "h-11 w-full min-w-0 rounded-lg border border-border bg-card px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function StatusLabel({ value }: { value: string | null }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full rounded-md px-2 py-1 text-xs font-medium leading-4",
        value === "BLOCK"
          ? "bg-secondary text-foreground"
          : value === "REQUIRE_APPROVAL"
            ? "bg-sand text-foreground"
            : "bg-secondary/70 text-muted-foreground",
      )}
    >
      {value?.replaceAll("_", " ") ?? "Not yet recorded"}
    </span>
  );
}

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
    headerName: "Activity date · UTC",
    valueFormatter: ({ value }: ValueFormatterParams<TransactionRow>) =>
      formatDate(String(value ?? "")),
    width: 170,
    minWidth: 170,
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
    width: 220,
    minWidth: 220,
    tooltipField: "product.title",
  },
  {
    field: "amountMinor",
    headerName: "Amount",
    valueFormatter: ({ value }: ValueFormatterParams<TransactionRow>) =>
      formatUsdLabel(Number(value)),
    width: 105,
    minWidth: 105,
  },
  {
    field: "decision",
    headerName: "Decision",
    minWidth: 180,
    width: 180,
    cellRenderer: ({ value }: ICellRendererParams<TransactionRow>) => (
      <StatusLabel value={typeof value === "string" ? value : null} />
    ),
  },
  {
    field: "paypalStatus",
    headerName: "Payment",
    width: 180,
    minWidth: 180,
    valueFormatter: ({ value }: ValueFormatterParams<TransactionRow>) =>
      typeof value === "string" ? value.replaceAll("_", " ") : "Not recorded",
  },
  {
    field: "mandate.title",
    headerName: "Mandate",
    valueGetter: ({ data }: ValueGetterParams<TransactionRow>) =>
      data ? `${data.mandate.title} · v${data.mandate.version}` : "—",
    minWidth: 180,
  },
  { field: "merchant", headerName: "Merchant", minWidth: 140 },
  { field: "approvalType", headerName: "Approval", minWidth: 140 },
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
    headerName: "Date · UTC",
    valueFormatter: ({ value }: ValueFormatterParams<PolicyEventRow>) =>
      formatDate(String(value ?? "")),
    minWidth: 170,
    width: 170,
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
    minWidth: 260,
    width: 260,
    tooltipField: "product.title",
  },
  {
    field: "reasonCodes",
    headerName: "Reason codes",
    valueFormatter: ({ value }: ValueFormatterParams<PolicyEventRow>) =>
      Array.isArray(value) ? value.join(", ") : "—",
    minWidth: 240,
    width: 240,
  },
  {
    field: "product.merchant",
    headerName: "Merchant",
    valueGetter: ({ data }: ValueGetterParams<PolicyEventRow>) => data?.product.merchant,
    minWidth: 170,
    width: 170,
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
    <div className="min-w-0 bg-card px-5 py-6 sm:px-6">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 break-words text-[28px] font-medium leading-tight tracking-[-0.03em] tabular-nums sm:text-[32px]">
        {value}
      </p>
      {detail ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p> : null}
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
    <section className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {description ? <p className="text-[11px] text-muted-foreground">{description}</p> : null}
      </div>
      {rows.length ? (
        <div className="mt-6 space-y-4">
          {rows.map((row) => {
            const value = row.amountMinor ?? row.count ?? 0;
            return (
              <div key={row.label}>
                <div className="flex justify-between gap-4 text-xs">
                  <span className="min-w-0 break-words">{row.label}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {valueLabel(row)}
                  </span>
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-secondary">
                  <div
                    className="h-1.5 rounded-full bg-foreground/70"
                    style={{ width: `${(value / max) * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-6 flex min-h-16 items-center gap-3 text-xs leading-5 text-muted-foreground">
          <BarChart3 size={19} className="shrink-0" aria-hidden="true" />
          <p>No captured spend in this view. Completed payments will appear here.</p>
        </div>
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
  const [loadFailed, setLoadFailed] = useState(false);
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
    setLoadFailed(false);
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
      setLoadFailed(true);
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
      <div role="status" aria-live="polite" className="space-y-6">
        <span className="sr-only">Loading verified control-center data…</span>
        <div
          aria-hidden="true"
          className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4"
        >
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="space-y-4 bg-card p-6">
              <div className="h-3 w-24 rounded bg-secondary" />
              <div className="h-8 w-20 rounded bg-secondary motion-safe:animate-pulse" />
              <div className="h-3 w-32 max-w-full rounded bg-secondary" />
            </div>
          ))}
        </div>
        <div
          aria-hidden="true"
          className="h-80 rounded-xl border border-border bg-card motion-safe:animate-pulse"
        />
      </div>
    );
  if (error && loadFailed && !transactions.length && !policyEvents.length)
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
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <ShieldCheck size={15} aria-hidden="true" />
            All-time overview · verified application records
          </span>
          <Link
            href="/approvals"
            className="inline-flex min-h-11 items-center gap-1.5 font-medium text-foreground hover:underline underline-offset-4"
          >
            Review approvals
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
          <Metric
            label="Captured purchases"
            value={String(totals.purchases)}
            detail={`Policy decisions: ${totals.policyAllowed} allowed · ${totals.humanApproved} human-approved`}
          />
          <Metric
            label="Captured spend"
            value={formatUsdLabel(totals.spendMinor)}
            detail={`${formatUsdLabel(totals.refundsMinor)} refunded`}
          />
          <Metric
            label="Blocked attempts"
            value={String(totals.blocked)}
            detail="Prevented by AgentGuard"
          />
          <Metric
            label="Active mandates"
            value={String(totals.activeMandates)}
            detail="Your current purchasing permissions"
          />
        </div>
        <section
          aria-labelledby="transactions-heading"
          className="min-w-0 overflow-hidden rounded-xl border border-border bg-card"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5 sm:px-6">
            <div>
              <h2 id="transactions-heading" className="text-lg font-medium tracking-[-0.02em]">
                Transactions
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {scopeLabel}. Open a product to inspect its decision and audit trail.
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
          <div className="border-y border-border bg-secondary/45 px-5 py-5 sm:px-6">
            <label htmlFor="dashboard-query" className="mb-2 block text-sm font-medium">
              Ask the control center{" "}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                Read-only analytics
              </span>
            </label>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void runQuery();
              }}
              className="flex flex-col gap-2 sm:flex-row"
            >
              <input
                id="dashboard-query"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Show blocked transactions this week"
                className={cn(fieldClass, "sm:flex-1")}
              />
              <button
                type="submit"
                disabled={queryLoading || !query.trim()}
                className={cn(buttonVariants(), "rounded-lg")}
              >
                {queryLoading ? (
                  <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Search size={15} aria-hidden="true" />
                )}{" "}
                Ask
              </button>
            </form>
            {clarification ? (
              <p
                className="mt-4 rounded-xl border border-border bg-secondary px-4 py-3 text-sm"
                role="status"
              >
                {clarification}
              </p>
            ) : null}
            {filterLabels.length ? (
              <div className="mt-4 flex flex-wrap gap-2 text-xs" aria-label="Applied filters">
                {filterLabels.map((label) => (
                  <span key={label} className="rounded-full bg-sand px-2.5 py-1">
                    {label}
                  </span>
                ))}
              </div>
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void applyFilters();
              }}
              className="mt-5 grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1.2fr_1fr_auto]"
            >
              <label className="min-w-0 space-y-2 text-xs text-muted-foreground">
                <span>Minimum · USD</span>
                <input
                  value={minAmount}
                  onChange={(event) => setMinAmount(event.currentTarget.value)}
                  placeholder="Min amount USD"
                  inputMode="decimal"
                  className={cn(fieldClass, "text-foreground")}
                />
              </label>
              <label className="min-w-0 space-y-2 text-xs text-muted-foreground">
                <span>Maximum · USD</span>
                <input
                  value={maxAmount}
                  onChange={(event) => setMaxAmount(event.currentTarget.value)}
                  placeholder="Max amount USD"
                  inputMode="decimal"
                  className={cn(fieldClass, "text-foreground")}
                />
              </label>
              <label className="min-w-0 space-y-2 text-xs text-muted-foreground">
                <span>Policy decision</span>
                <select
                  value={decision}
                  onChange={(event) => setDecision(event.currentTarget.value)}
                  className={cn(fieldClass, "text-foreground")}
                >
                  <option value="">All decisions</option>
                  <option value="ALLOW">Allowed</option>
                  <option value="REQUIRE_APPROVAL">Approval required</option>
                  <option value="BLOCK">Blocked</option>
                </select>
              </label>
              <label className="min-w-0 space-y-2 text-xs text-muted-foreground">
                <span>Category</span>
                <input
                  value={category}
                  onChange={(event) => setCategory(event.currentTarget.value)}
                  placeholder="Category"
                  className={cn(fieldClass, "text-foreground")}
                />
              </label>
              <button
                type="submit"
                className={cn(
                  buttonVariants({ variant: "outline" }),
                  "rounded-lg sm:col-span-2 xl:col-span-1",
                )}
              >
                Apply
              </button>
            </form>
            {error ? (
              <p className="mt-4 text-sm text-foreground" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          {!transactions.length ? (
            <div className="px-6 py-12 text-center">
              <Search size={23} className="mx-auto text-muted-foreground" aria-hidden="true" />
              <h3 className="mt-4 text-sm font-medium">
                {filterLabels.length
                  ? "No transactions match these filters."
                  : "Your activity starts here."}
              </h3>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                {filterLabels.length
                  ? "Adjust the filters or reset them to see all your transactions."
                  : "Create a mandate and prepare a purchase. Its policy decision and payment status will appear here."}
              </p>
              {!filterLabels.length ? (
                <Link
                  href="/mandates/new"
                  className={cn(buttonVariants({ variant: "outline" }), "mt-5")}
                >
                  Create your first mandate
                  <ArrowUpRight size={15} aria-hidden="true" />
                </Link>
              ) : null}
            </div>
          ) : (
            <>
              <div className="hidden min-w-0 px-5 py-5 xl:block sm:px-6">
                <AgGridReact<TransactionRow>
                  theme={warmTheme}
                  rowData={transactions}
                  columnDefs={transactionColumns}
                  getRowId={({ data }: GetRowIdParams<TransactionRow>) => data.id}
                  domLayout="autoHeight"
                  pagination={false}
                  suppressCellFocus={false}
                  defaultColDef={{ sortable: true, resizable: true }}
                />
                <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <ArrowLeftRight size={14} aria-hidden="true" />
                  Scroll horizontally for mandate, merchant, approval, and refund details.
                </p>
              </div>
              <div className="divide-y divide-border xl:hidden">
                {transactions.map((row) => (
                  <article key={row.id} className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <Link
                        href={transactionDetailHref(row)}
                        aria-label={`Open details for ${row.product.title}`}
                        className="min-w-0 text-sm font-medium leading-6 hover:underline underline-offset-4"
                      >
                        {row.product.title}
                        <ArrowUpRight size={13} className="ml-1 inline" aria-hidden="true" />
                      </Link>
                      <span className="shrink-0 text-sm font-medium tabular-nums">
                        {formatUsdLabel(row.amountMinor)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{row.merchant}</p>
                    <div className="mt-3">
                      <StatusLabel value={row.decision} />
                    </div>
                    <dl className="mt-4 space-y-2 text-xs">
                      {[
                        ["Date · UTC", formatDate(row.activityAt)],
                        ["Mandate", `${row.mandate.title} · v${row.mandate.version}`],
                        ["Approval", row.approvalType?.replaceAll("_", " ") ?? "—"],
                        ["Payment", row.paypalStatus?.replaceAll("_", " ") ?? "Not yet recorded"],
                        ["Refund", refundStatus(row.paypalStatus)],
                      ].map(([label, value]) => (
                        <div key={label} className="grid grid-cols-[80px_1fr] gap-3">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="min-w-0 break-words text-right">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                ))}
              </div>
            </>
          )}
          {nextCursor ? (
            <div className="flex justify-center border-t border-border p-5">
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
          <div
            className={cn("grid gap-4", chartIntent === null ? "xl:grid-cols-3" : "sm:grid-cols-2")}
          >
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
        <section className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-medium tracking-[-0.02em]">Policy violations</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Blocked proposal decisions returned by AgentGuard.
              </p>
            </div>
            <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
              {policyEvents.length} events
            </span>
          </div>
          {!policyEvents.length ? (
            <div className="mt-5 flex items-center gap-3 border-t border-border py-6 text-sm text-muted-foreground">
              <ShieldCheck size={20} className="shrink-0" aria-hidden="true" />
              <p>No blocked proposals. Policy violations will be recorded here.</p>
            </div>
          ) : (
            <>
              <div className="mt-5 hidden min-w-0 xl:block">
                <AgGridReact<PolicyEventRow>
                  theme={warmTheme}
                  rowData={policyEvents}
                  columnDefs={policyColumns}
                  getRowId={({ data }: GetRowIdParams<PolicyEventRow>) => data.id}
                  domLayout="autoHeight"
                  pagination={false}
                  suppressCellFocus={false}
                  defaultColDef={{ sortable: true, resizable: true }}
                />
                <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <ArrowLeftRight size={14} aria-hidden="true" />
                  Scroll horizontally for the complete mandate details.
                </p>
              </div>
              <div className="mt-5 divide-y divide-border border-t border-border xl:hidden">
                {policyEvents.map((event) => (
                  <article key={event.id} className="py-4">
                    <Link
                      href={`/proposals/${encodeURIComponent(event.proposalId)}`}
                      className="text-sm font-medium leading-6 hover:underline underline-offset-4"
                    >
                      {event.product.title}
                      <ArrowUpRight size={13} className="ml-1 inline" aria-hidden="true" />
                    </Link>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {event.product.merchant} · {formatDate(event.createdAt)} UTC
                    </p>
                    <p className="mt-3 text-xs leading-5">
                      {event.reasonCodes.map((code) => code.replaceAll("_", " ")).join(", ")}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {event.mandate.title} · v{event.mandate.version}
                    </p>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </AgGridProvider>
  );
}
