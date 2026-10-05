import { notFound } from "next/navigation";
import { requireUiFixtures } from "@/lib/ui-fixtures";
import { PageHeader } from "@/components/admin/page-header";
export default async function FixtureDetail({ params }: { params: Promise<{ id: string }> }) {
  requireUiFixtures();
  const { id } = await params;
  if (!/^fixture-[1-6]$/u.test(id)) notFound();
  return (
    <>
      <PageHeader
        title={`Sample record ${id}`}
        description="Synthetic UI test record. No operational data or action."
        breadcrumbs={[
          { label: "My Session", href: "/" },
          { label: "UI fixtures", href: "/ui-fixtures" },
          { label: id },
        ]}
      />
      <p className="rounded-2xl border bg-card p-6">This is the selected fixture record.</p>
    </>
  );
}
