import { ClipboardCheck } from "lucide-react";
import { ApprovalInbox } from "@/components/approval-inbox";
import { WorkspacePage } from "../_components/workspace-page";

export default function ApprovalsPage() {
  return (
    <WorkspacePage
      title="Approvals"
      description="Keep the final decision close. Proposals that sit above an autonomous limit will wait here for a clear answer."
      icon={ClipboardCheck}
    >
      <ApprovalInbox />
    </WorkspacePage>
  );
}
