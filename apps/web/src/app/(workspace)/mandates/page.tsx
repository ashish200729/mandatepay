import { ShieldCheck } from "lucide-react";
import { MandateList } from "@/components/mandate-list";
import { WorkspacePage } from "../_components/workspace-page";

export default function MandatesPage() {
  return (
    <WorkspacePage
      title="Purchase mandates"
      description="Review the permissions that shape what an AI agent may propose, what it can spend automatically, and when it must ask."
      icon={ShieldCheck}
    >
      <MandateList />
    </WorkspacePage>
  );
}
