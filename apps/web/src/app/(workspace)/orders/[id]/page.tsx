import { OrderDetail } from "@/components/order-detail";

export default async function OrderDetailPage({
  searchParams,
  params,
}: {
  searchParams: Promise<{ paypal?: string }>;
  params: Promise<{ id: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <OrderDetail key={id} paymentId={id} paypalState={query.paypal ?? null} />;
}
