import { ClipboardCheck } from "lucide-react";
import { ApprovalInbox } from "@/components/approval-inbox";
import { WorkspacePage } from "../_components/workspace-page";

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ proposal?: string }>;
}) {
  const params = await searchParams;
  return (
    <WorkspacePage
      title="Approvals"
      description="Keep the final decision close. Proposals that sit above an autonomous limit will wait here for a clear answer."
      icon={ClipboardCheck}
    >
      <ApprovalInbox
        key={params.proposal ?? "default"}
        initialProposalId={typeof params.proposal === "string" ? params.proposal : ""}
      />
    </WorkspacePage>
  );
}
