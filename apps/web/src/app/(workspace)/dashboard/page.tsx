import { BarChart3 } from "lucide-react";
import { AgentControlCenter } from "@/components/agent-control-center";
import { WorkspacePage } from "../_components/workspace-page";

export default function DashboardPage() {
  return (
    <WorkspacePage
      title="Agent Control Center"
      description="Understand how your permissions are being used: autonomous decisions, human approvals, blocked attempts, and verified payments."
      icon={BarChart3}
    >
      <AgentControlCenter />
    </WorkspacePage>
  );
}
