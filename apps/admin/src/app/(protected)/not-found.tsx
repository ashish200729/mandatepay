import { AdminLink as Link } from "@/components/admin/link";
import { PageHeader } from "@/components/admin/page-header";
import { EmptyState } from "@/components/admin/states";
import { buttonVariants } from "@mandatepay/ui/components/button";

export default function RecordNotFound() {
  return (
    <>
      <PageHeader
        title="Record not found"
        description="This record is not available at this address. Check the link or return to the overview."
        breadcrumbs={[{ label: "Overview", href: "/" }, { label: "Not found" }]}
      />
      <EmptyState
        title="No record at this address"
        description="Use the record lists to find the current operational record."
        action={
          <Link className={buttonVariants({ variant: "outline" })} href="/">
            Back to overview
          </Link>
        }
      />
    </>
  );
}
