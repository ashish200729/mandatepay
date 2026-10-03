"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { cn } from "@mandatepay/ui/lib/utils";
import { listMandates } from "@/lib/mandates/client";
import { formatUsdLabel } from "@/lib/mandates/money";
import type { MandateDetail } from "@/lib/mandates/types";
import {
  compareProducts,
  createProposal,
  createProposalRequestKey,
  evaluateProposal,
  safeExternalUrl,
  searchProducts,
} from "@/lib/products/client";
import type { NormalizedProduct, ProductRanking, PurchaseProposal } from "@/lib/products/types";
import { activeShoppingMandates, selectShoppingMandate } from "@/lib/agent/mandates";
import {
  workspaceField,
  WorkspaceLoading,
  WorkspaceSteps,
  WorkspaceStatus,
} from "@/components/workspace-ui";

function sourceLabel(source: NormalizedProduct["source"]) {
  return source === "demo" ? "Demo Catalog" : "Channel3 discovery";
}

function ProductCard({
  product,
  selected,
  recommended,
  onToggle,
  disabled,
  selectionFull,
  onPropose,
}: {
  product: NormalizedProduct;
  selected: boolean;
  recommended: ProductRanking | undefined;
  onToggle: () => void;
  disabled: boolean;
  selectionFull: boolean;
  onPropose: () => void;
}) {
  const productUrl = product.source === "channel3" ? safeExternalUrl(product.productUrl) : null;
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col rounded-xl border bg-card p-5 transition-colors motion-reduce:transition-none",
        selected ? "border-foreground" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <span className="inline-flex rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            {sourceLabel(product.source)}
          </span>
          <h3 className="mt-3 break-words text-base font-medium leading-6">{product.title}</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {product.brand} · {product.merchant}
          </p>
        </div>
        <span className="shrink-0 text-lg font-medium tabular-nums">
          {formatUsdLabel(product.priceMinor)}
        </span>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 text-xs">
        <div>
          <dt className="text-muted-foreground">Condition</dt>
          <dd className="mt-1 font-medium">{product.condition}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Category</dt>
          <dd className="mt-1 font-medium">{product.category ?? "—"}</dd>
        </div>
      </dl>
      {recommended ? (
        <div className="mt-5 rounded-xl bg-sand p-4 text-sm leading-relaxed">
          <p className="flex items-center gap-2 font-medium">
            <Sparkles size={15} aria-hidden="true" /> Recommended #{recommended.rank}
          </p>
          <p className="mt-2 text-muted-foreground">{recommended.explanation}</p>
          {recommended.tradeoffs.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Trade-off: {recommended.tradeoffs.join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-ring">
          <input
            type="checkbox"
            checked={selected}
            disabled={disabled || (!selected && selectionFull)}
            onChange={onToggle}
            className="size-4 accent-primary"
          />{" "}
          Compare
        </label>
        {productUrl ? (
          <a
            href={productUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-2 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            View source <ExternalLink size={13} aria-hidden="true" />
          </a>
        ) : null}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        {product.source === "demo"
          ? "This catalog item can become a local proposal."
          : "External discovery only. It cannot be sent to checkout."}
      </p>
      {recommended && product.source === "demo" ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onPropose}
          className={cn(
            buttonVariants({ variant: "outline" }),
            "mt-4 h-auto min-h-11 whitespace-normal rounded-lg py-2 text-left",
          )}
        >
          Prepare proposal · {product.title}
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      ) : null}
    </article>
  );
}

export function ProductDiscovery({ initialMandateId = "" }: { initialMandateId?: string }) {
  const [mandates, setMandates] = useState<MandateDetail[]>([]);
  const [mandatesLoading, setMandatesLoading] = useState(true);
  const [mandateId, setMandateId] = useState(initialMandateId);
  const [searched, setSearched] = useState(false);
  const [mandateError, setMandateError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<NormalizedProduct[]>([]);
  const [mode, setMode] = useState<"demo" | "channel3" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [ranking, setRanking] = useState<ProductRanking[]>([]);
  const [proposal, setProposal] = useState<PurchaseProposal | null>(null);
  const [proposalAttempt, setProposalAttempt] = useState<{
    mandateId: string;
    productId: string;
    requestKey: string;
  } | null>(null);
  const [loading, setLoading] = useState<"search" | "compare" | "proposal" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeMandate = useMemo(
    () => mandates.find((mandate) => mandate.id === mandateId) ?? null,
    [mandates, mandateId],
  );

  const loadMandates = useCallback(async () => {
    setMandatesLoading(true);
    setMandateError(null);
    try {
      const next = await listMandates();
      const active = activeShoppingMandates(next);
      setMandates(active);
      const selectedId = selectShoppingMandate(active, initialMandateId);
      setMandateId(selectedId);
      const selected = active.find((mandate) => mandate.id === selectedId);
      if (selected) setQuery((current) => current || selected.rules.productIntent);
    } catch (cause) {
      setMandateError(cause instanceof Error ? cause.message : "Mandates could not be loaded.");
    } finally {
      setMandatesLoading(false);
    }
  }, [initialMandateId]);

  useEffect(() => {
    // Initial client synchronization with the protected mandate collection.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMandates();
  }, [loadMandates]);

  function toggleProduct(product: NormalizedProduct) {
    setSelectedIds((current) => {
      if (current.includes(product.externalId))
        return current.filter((id) => id !== product.externalId);
      if (current.length >= 3) return current;
      return [...current, product.externalId];
    });
    setRanking([]);
    setProposal(null);
    setProposalAttempt(null);
  }

  async function search() {
    if (!activeMandate || loading) return;
    setLoading("search");
    setSearched(true);
    setError(null);
    setRanking([]);
    setProposal(null);
    setProposalAttempt(null);
    setSelectedIds([]);
    try {
      const result = await searchProducts(activeMandate.id, query);
      setProducts(result.products);
      setMode(result.mode);
      setNotice(result.notice);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Product search is unavailable.");
      setProducts([]);
    } finally {
      setLoading(null);
    }
  }

  async function compare() {
    if (!activeMandate || loading || selectedIds.length === 0) return;
    setLoading("compare");
    setError(null);
    try {
      const selected = products.filter((product) => selectedIds.includes(product.externalId));
      setRanking(await compareProducts(activeMandate.id, selected));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Product comparison is unavailable.");
    } finally {
      setLoading(null);
    }
  }

  async function propose(product: NormalizedProduct) {
    if (!activeMandate || product.source !== "demo" || loading) return;
    setLoading("proposal");
    setError(null);
    try {
      const attempt =
        proposalAttempt?.mandateId === activeMandate.id &&
        proposalAttempt.productId === product.externalId
          ? proposalAttempt
          : {
              mandateId: activeMandate.id,
              productId: product.externalId,
              requestKey: createProposalRequestKey(),
            };
      setProposalAttempt(attempt);
      const draft = await createProposal(activeMandate.id, product, attempt.requestKey);
      setProposal(await evaluateProposal(draft.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The proposal could not be created.");
    } finally {
      setLoading(null);
    }
  }

  if (mandatesLoading) return <WorkspaceLoading label="Loading active mandates…" />;
  if (mandateError) {
    return (
      <div
        className="rounded-2xl border border-destructive/20 bg-destructive/8 p-6 text-sm"
        role="alert"
      >
        <p>{mandateError}</p>
        <button
          type="button"
          onClick={() => void loadMandates()}
          className="mt-4 font-medium underline underline-offset-4"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!mandates.length) {
    return (
      <section className="rounded-2xl border border-border bg-card p-8 text-center sm:p-14">
        <ShieldCheck size={28} className="mx-auto" aria-hidden="true" />
        <h2 className="mt-5 font-editorial text-3xl tracking-[-0.025em]">
          Activate a mandate first.
        </h2>
        <p className="mx-auto mt-3 max-w-[480px] text-sm leading-relaxed text-muted-foreground">
          Product search and proposals always run against an active permission set.
        </p>
        <Link href="/mandates/new" className={cn(buttonVariants({ size: "lg" }), "mt-6")}>
          Create a mandate <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <WorkspaceSteps
        steps={["Find products", "Compare options", "Review proposal"]}
        current={proposal ? 2 : ranking.length ? 1 : 0}
      />
      <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <label className="block text-sm font-medium">
              Shopping permissions
              <select
                value={mandateId}
                disabled={loading !== null}
                onChange={(event) => {
                  const id = event.currentTarget.value;
                  setMandateId(id);
                  setQuery(
                    mandates.find((mandate) => mandate.id === id)?.rules.productIntent ?? "",
                  );
                  setProducts([]);
                  setSelectedIds([]);
                  setRanking([]);
                  setProposal(null);
                  setProposalAttempt(null);
                  setSearched(false);
                  setError(null);
                  setNotice(null);
                }}
                className={cn(workspaceField, "mt-2 block sm:w-96")}
              >
                <option value="">Choose a mandate</option>
                {mandates.map((mandate) => (
                  <option key={mandate.id} value={mandate.id}>
                    {mandate.title} · v{mandate.version}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1 text-sm text-muted-foreground">
              {activeMandate ? (
                <>
                  Automatic {formatUsdLabel(activeMandate.rules.autoSpendLimit)} · Maximum{" "}
                  {formatUsdLabel(activeMandate.rules.transactionLimit)} ·{" "}
                  {activeMandate.rules.allowedConditions.join(", ")}
                </>
              ) : (
                "Select the permission set for this search. No mandate is chosen automatically when several are active."
              )}
            </p>
          </div>
          {activeMandate ? (
            <Link
              href={`/mandates/${encodeURIComponent(activeMandate.id)}`}
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            >
              View permissions
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          ) : null}
        </div>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <label className="min-w-0 sm:flex-1">
            <span className="sr-only">Search products</span>
            <div className="relative">
              <Search
                size={17}
                className="pointer-events-none absolute left-4 top-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void search();
                }}
                placeholder="Search products within this mandate"
                disabled={!activeMandate || loading !== null}
                className={cn(workspaceField, "h-12 pl-11")}
              />
            </div>
          </label>
          <button
            type="button"
            onClick={() => void search()}
            disabled={loading !== null || !activeMandate || !query.trim()}
            className={cn(buttonVariants({ size: "lg" }), "sm:min-w-32")}
          >
            {loading === "search" ? (
              <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <Search size={16} aria-hidden="true" />
            )}{" "}
            {loading === "search" ? "Searching…" : "Search"}
          </button>
        </div>
      </section>

      {notice ? (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground">
          <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
          {notice}
        </div>
      ) : null}
      {error ? (
        <div
          className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm"
          role="alert"
        >
          <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : null}
      {products.length ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {products.length} products · {mode === "demo" ? "Demo Catalog" : "Channel3 discovery"} ·
            choose up to 3 to compare
          </p>
          <button
            type="button"
            onClick={() => void compare()}
            disabled={loading !== null || !selectedIds.length}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            {loading === "compare" ? (
              <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles size={15} aria-hidden="true" />
            )}{" "}
            Compare selected ({selectedIds.length})
          </button>
        </div>
      ) : null}
      {products.length ? (
        <div className="grid gap-5 lg:grid-cols-2">
          {[...products]
            .sort(
              (a, b) =>
                (ranking.find((item) => item.productId === a.externalId)?.rank ?? 999) -
                (ranking.find((item) => item.productId === b.externalId)?.rank ?? 999),
            )
            .map((product) => (
              <ProductCard
                key={`${product.source}:${product.externalId}`}
                product={product}
                selected={selectedIds.includes(product.externalId)}
                recommended={ranking.find((item) => item.productId === product.externalId)}
                onToggle={() => toggleProduct(product)}
                disabled={loading !== null}
                selectionFull={selectedIds.length >= 3}
                onPropose={() => void propose(product)}
              />
            ))}
        </div>
      ) : null}
      {ranking.length ? (
        <section className="border-t border-border pt-5">
          <h2 className="text-base font-medium">Comparison ready.</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The ranking explains fit and trade-offs. Select a Demo Catalog recommendation to prepare
            a proposal.
          </p>
        </section>
      ) : null}
      {proposal ? (
        <section className="rounded-2xl border border-sand-border bg-sand p-5 sm:p-7" role="status">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck size={17} aria-hidden="true" /> Proposal evaluated
          </div>
          <div className="mt-3">
            <WorkspaceStatus value={proposal.decision ?? proposal.status ?? "PROPOSAL_READY"} />
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {proposal.policyReason ??
              proposal.reason ??
              "The proposal is ready for the next permission step."}
          </p>
          <p className="mt-5 text-xs text-muted-foreground">
            This phase does not execute payment. An authorized Demo Catalog proposal can continue to
            Sandbox checkout.
          </p>
          {proposal.status === "AUTHORIZED" ? (
            <Link
              href={`/orders/new?proposalId=${encodeURIComponent(proposal.id)}`}
              className={cn(buttonVariants({ size: "sm" }), "mt-5")}
            >
              Continue to Sandbox checkout <ArrowRight size={15} aria-hidden="true" />
            </Link>
          ) : null}
          {proposal.status === "AWAITING_APPROVAL" ? (
            <Link
              href={`/approvals?proposal=${encodeURIComponent(proposal.id)}`}
              className={cn(buttonVariants({ size: "sm" }), "mt-5")}
            >
              Review approval
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          ) : null}
        </section>
      ) : null}
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle
            size={15}
            className="animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {loading === "compare"
            ? "Comparing selected products…"
            : loading === "proposal"
              ? "Preparing your proposal…"
              : "Searching your catalog…"}
        </p>
      ) : !products.length && !error ? (
        <div className="py-8 text-center">
          <Search size={24} className="mx-auto text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-4 text-base font-medium">
            {searched ? "No matching products." : "Find the right option."}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {searched
              ? "Try a different search within your mandate."
              : "Search, choose up to three products, then compare their fit."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
