import { Search } from "lucide-react";
import { ProductDiscovery } from "@/components/product-discovery";
import { WorkspacePage } from "../_components/workspace-page";

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<{ mandate?: string }>;
}) {
  const params = await searchParams;
  return (
    <WorkspacePage
      title="Discover products"
      description="Search your catalog, compare options, and prepare a purchase under the permissions you choose."
      icon={Search}
    >
      <ProductDiscovery
        key={params.mandate ?? "default"}
        initialMandateId={typeof params.mandate === "string" ? params.mandate : ""}
      />
    </WorkspacePage>
  );
}
