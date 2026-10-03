import { MessageCircle } from "lucide-react";
import { ProductDiscovery } from "@/components/product-discovery";
import { ShoppingChat } from "@/components/shopping-chat";
import { WorkspacePage } from "../_components/workspace-page";

export default function ChatPage() {
  return (
    <WorkspacePage
      title="Your shopping brief starts here."
      description="Choose a purchase mandate and describe what you need. The agent finds options; AgentGuard checks your permissions. You can also find a previous purchase and prepare a refund for review."
      icon={MessageCircle}
    >
      <ShoppingChat />
      <details className="mt-8 rounded-2xl border border-border bg-card p-5 sm:p-7">
        <summary className="cursor-pointer font-editorial text-2xl tracking-[-0.02em] underline-offset-4 hover:underline">
          Use structured product discovery instead
        </summary>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Search and compare trusted catalog records manually when you want a more explicit path.
        </p>
        <div className="mt-6">
          <ProductDiscovery />
        </div>
      </details>
    </WorkspacePage>
  );
}
