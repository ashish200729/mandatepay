import { OrderCheckout } from "@/components/order-checkout";

export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ proposalId?: string }>;
}) {
  const { proposalId } = await searchParams;
  if (!proposalId)
    return (
      <p className="rounded-2xl border border-border bg-card p-6 text-sm">
        A proposal is required to start Sandbox checkout.
      </p>
    );
  return <OrderCheckout proposalId={proposalId} />;
}
