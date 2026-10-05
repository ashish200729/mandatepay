import type { TableQuerySpec } from "./table-query";
export const fixtureSpec: TableQuerySpec = {
  search: true,
  filters: { status: ["SUCCESS", "FAILURE"] },
  dates: true,
  sortKeys: ["name", "createdAt"],
};
export type FixtureRow = {
  id: string;
  name: string;
  status: "SUCCESS" | "FAILURE";
  createdAt: string;
};
