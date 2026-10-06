import { OperationsCollection } from "@/components/admin/operations-collection";
export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <OperationsCollection resource="approvals" searchParams={searchParams} />;
}
