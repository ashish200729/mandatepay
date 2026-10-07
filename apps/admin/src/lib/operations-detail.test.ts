import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./admin-fetch", () => ({ adminApi: vi.fn() }));
vi.mock("../components/admin/page-header", () => ({ PageHeader: () => null }));
vi.mock("../components/admin/admin-actions", () => ({}));
import { adminApi } from "./admin-fetch";
import { OperationsDetail } from "../components/admin/operations-detail";

describe("admin record failure states", () => {
  it("offers recovery for an unavailable service instead of reporting a missing record", async () => {
    vi.mocked(adminApi).mockResolvedValue({ status: 503, json: null });
    const page = await OperationsDetail({ resource: "payments", id: "payment-fixture" });
    const html = renderToStaticMarkup(page);
    expect(html).toContain("This record could not be loaded");
    expect(html).toContain('href="/payments/payment-fixture"');
    expect(html).toContain("Reload");
  });
  it("treats an invalid response as unavailable", async () => {
    vi.mocked(adminApi).mockResolvedValue({ status: 200, json: { data: { token: "private" } } });
    const html = renderToStaticMarkup(
      await OperationsDetail({ resource: "users", id: "user-fixture" }),
    );
    expect(html).toContain("This record could not be loaded");
    expect(html).not.toContain("private");
  });
  it("reserves not-found behavior for an actual 404", async () => {
    vi.mocked(adminApi).mockResolvedValue({ status: 404, json: null });
    await expect(OperationsDetail({ resource: "users", id: "user-fixture" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});
