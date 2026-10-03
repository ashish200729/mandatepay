import { Package } from "lucide-react";
import { OrderList } from "@/components/order-list";
import { WorkspacePage } from "../_components/workspace-page";

export default function OrdersPage() {
  return (
    <WorkspacePage
      title="Orders"
      description="See the purchases your agent proposed, the decisions AgentGuard made, and what PayPal actually confirmed."
      icon={Package}
    >
      <OrderList />
    </WorkspacePage>
  );
}
