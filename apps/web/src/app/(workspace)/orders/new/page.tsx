import { OrderCheckout } from "@/components/order-checkout";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { WorkspaceEmpty } from "@/components/workspace-ui";
import { WorkspacePage } from "../../_components/workspace-page";

export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ proposalId?: string }>;
}) {
  const { proposalId } = await searchParams;
  if (typeof proposalId !== "string" || !proposalId)
    return (
      <WorkspacePage
        title="Checkout"
        description="Review an authorized proposal before continuing to PayPal Sandbox."
        icon={ShieldCheck}
      >
        <WorkspaceEmpty
          icon={ShieldCheck}
          title="Choose a proposal first."
          description="An authorized purchase proposal keeps checkout tied to your exact product, total, and permissions."
        >
          <Link href="/approvals" className={buttonVariants({ variant: "outline" })}>
            Review proposals
          </Link>
        </WorkspaceEmpty>
      </WorkspacePage>
    );
  return <OrderCheckout key={proposalId} proposalId={proposalId} />;
}
