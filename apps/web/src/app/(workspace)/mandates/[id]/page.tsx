import { MandateDetail } from "@/components/mandate-detail";

export default async function MandateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MandateDetail mandateId={id} />;
}
