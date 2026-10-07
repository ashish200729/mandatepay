"use client";
import { useRouter } from "next/navigation";
import { Button } from "@mandatepay/ui/components/button";
import { useTableQuery } from "@/lib/use-table-query";
import { FilterBar } from "./filters";
import { DataTable, type TableColumn, type TableState } from "./data-table";
import { resourceSpecs } from "@/lib/resource-specs";
import { columnsFor } from "./operations-columns";
import { Download } from "lucide-react";

export function CollectionView<T extends { id: string }>({
  resource,
  state,
}: {
  resource: keyof typeof resourceSpecs;
  state: TableState<T>;
}) {
  const router = useRouter();
  const config = resourceSpecs[resource];
  const navigation = useTableQuery(config.spec);
  return (
    <>
      <FilterBar
        navigation={navigation}
        search={"search" in config ? config.search : undefined}
        filters={config.filters}
        fields={config.fields}
        dates={config.dates}
        primaryFilterKey={
          {
            users: undefined,
            mandates: "status",
            proposals: "status",
            approvals: "decision",
            orders: "status",
            payments: "status",
            refunds: "status",
            webhooks: "status",
            audit: "result",
          }[resource]
        }
        actions={
          <Button variant="ghost" asChild>
            <a href={`/api/admin/${resource}/export?${navigation.query.params.toString()}`}>
              <Download size={15} aria-hidden="true" />
              Export CSV
            </a>
          </Button>
        }
      />
      <DataTable
        caption={config.caption}
        state={state}
        columns={columnsFor(resource) as readonly TableColumn<T>[]}
        getRowId={(row) => row.id}
        rowHref={(row) => `${config.path}/${encodeURIComponent(row.id)}`}
        pending={navigation.pending}
        onRetry={() => router.refresh()}
        onNext={navigation.next}
        onPrevious={navigation.previous}
        hasPrevious={navigation.hasPrevious}
        sort={{ key: navigation.query.sort, direction: navigation.query.direction }}
        onSort={navigation.sort}
      />
    </>
  );
}
