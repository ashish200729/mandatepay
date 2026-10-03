import { ShieldCheck } from "lucide-react";
import { MandateBuilder } from "@/components/mandate-builder";
import { WorkspacePage } from "../../_components/workspace-page";

export default function NewMandatePage() {
  return (
    <WorkspacePage
      title="Create a purchase mandate"
      description="Start with your intent. MandatePay will turn it into explicit permissions for you to review before anything is saved."
      icon={ShieldCheck}
    >
      <MandateBuilder />
    </WorkspacePage>
  );
}
