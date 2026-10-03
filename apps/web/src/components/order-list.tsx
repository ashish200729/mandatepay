"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, LoaderCircle, Package } from "lucide-react";
import { formatUsdLabel, formatUtcDate } from "@/lib/mandates/money";
import { listOrders } from "@/lib/payments/client";
import type { PaymentRecord } from "@/lib/payments/types";

function OrderCard({ order }: { order: PaymentRecord }) {
  return (
    <Link
      href={`/orders/${order.id}`}
      className="group block rounded-2xl border border-border bg-card p-5 transition-[border-color,box-shadow] hover:border-foreground/30 hover:shadow-[0_12px_32px_rgba(27,20,14,0.07)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:p-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sand">
            <Package size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-editorial text-2xl tracking-[-0.02em] group-hover:underline group-hover:underline-offset-4">
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
      <div className="mt-6 grid gap-4 border-t border-border pt-5 text-sm sm:grid-cols-3">
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
          <p className="mt-1 font-medium">{order.paypalCaptureId ?? "Not captured"}</p>
        </div>
      </div>
    </Link>
  );
}

export function OrderList() {
  const [orders, setOrders] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
  if (loading)
    return (
      <div
        className="flex min-h-56 items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle size={18} className="mr-2 animate-spin" aria-hidden="true" /> Loading orders…
      </div>
    );
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
      </section>
    );
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {orders.map((order) => (
        <OrderCard key={order.id} order={order} />
      ))}
    </div>
  );
}
