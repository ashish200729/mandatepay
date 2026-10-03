import { ProposalDetail } from "@/components/proposal-detail";

export default async function ProposalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProposalDetail key={id} proposalId={id} />;
}
