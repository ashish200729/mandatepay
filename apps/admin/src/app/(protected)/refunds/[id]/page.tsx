import { OperationsDetail } from "@/components/admin/operations-detail";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <OperationsDetail resource="refunds" id={(await params).id} />;
}
