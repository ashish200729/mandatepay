import { MessageCircle } from "lucide-react";
import { ProductDiscovery } from "@/components/product-discovery";
import { WorkspacePage } from "../_components/workspace-page";

export default function ChatPage() {
  return (
    <WorkspacePage
      title="Your shopping brief starts here."
      description="Describe what you need in your own words. MandatePay will turn the intent into clear purchasing permissions before an agent can propose anything."
      icon={MessageCircle}
    >
      <ProductDiscovery />
    </WorkspacePage>
  );
}
