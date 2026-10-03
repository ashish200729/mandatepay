"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Package } from "lucide-react";
import { formatUsdLabel, formatUtcDate } from "@/lib/mandates/money";
import { listOrders } from "@/lib/payments/client";
import type { PaymentRecord } from "@/lib/payments/types";
import { WorkspaceCollectionToolbar, WorkspaceLoading } from "@/components/workspace-ui";
import { buttonVariants } from "@mandatepay/ui/components/button";

function OrderCard({ order }: { order: PaymentRecord }) {
  return (
    <Link
      href={`/orders/${order.id}`}
      className="group block min-w-0 p-5 transition-colors hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sand">
            <Package size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0 break-words">
            <h2 className="text-lg font-medium leading-6 tracking-[-0.02em] group-hover:underline group-hover:underline-offset-4">
              {order.product.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {order.product.brand} · {order.product.merchant}
            </p>
          </div>
        </div>
        <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium">
          {order.status.replaceAll("_", " ")}
        </span>
      </div>
      <div className="mt-4 grid gap-4 border-t border-border pt-4 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted-foreground">Amount</p>
          <p className="mt-1 font-medium tabular-nums">{formatUsdLabel(order.amount)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Created</p>
          <p className="mt-1 font-medium">{formatUtcDate(order.createdAt)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">PayPal capture</p>
          <p className="mt-1 break-all font-medium">{order.paypalCaptureId ?? "Not captured"}</p>
        </div>
      </div>
    </Link>
  );
}

export function OrderList() {
  const [orders, setOrders] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOrders(await listOrders());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Orders could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  if (loading) return <WorkspaceLoading label="Loading orders…" />;
  if (error)
    return (
      <div
        className="rounded-2xl border border-destructive/20 bg-destructive/8 p-6 text-sm"
        role="alert"
      >
        <p>{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-4 font-medium underline underline-offset-4"
        >
          Try again
        </button>
      </div>
    );
  if (!orders.length)
    return (
      <section className="rounded-2xl border border-border bg-card p-8 text-center sm:p-14">
        <Check size={28} className="mx-auto" aria-hidden="true" />
        <h2 className="mt-5 font-editorial text-3xl tracking-[-0.025em]">No orders yet.</h2>
        <p className="mx-auto mt-3 max-w-[470px] text-sm leading-relaxed text-muted-foreground">
          Confirmed Sandbox payments will appear here with their server status, capture reference,
          and receipt details.
        </p>
        <Link href="/chat" className={buttonVariants({ variant: "outline", className: "mt-5" })}>
          Start a shopping brief
          <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </section>
    );
  const visible = orders.filter(
    (order) =>
      (!status || order.status === status) &&
      `${order.product.title} ${order.product.merchant}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  );
  return (
    <div className="space-y-5">
      <WorkspaceCollectionToolbar
        query={query}
        setQuery={setQuery}
        status={status}
        setStatus={setStatus}
        statuses={[...new Set(orders.map((order) => order.status))]}
        label="Search orders"
      />
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-3 text-xs text-muted-foreground">
          {visible.length} of {orders.length} payment records
        </div>
        <div className="divide-y divide-border">
          {visible.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </div>
        {!visible.length ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <p>No orders match these filters.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setStatus("");
              }}
              className={buttonVariants({ variant: "outline", size: "sm", className: "mt-4" })}
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
