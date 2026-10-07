import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));
import { cookies } from "next/headers";
import { adminApi } from "./admin-fetch";

describe("admin API session redirects", () => {
  afterEach(() => vi.restoreAllMocks());

  function session() {
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [{ name: "session", value: "fixture" }],
    } as unknown as Awaited<ReturnType<typeof cookies>>);
  }

  it.each([
    [401, "/login?state=expired"],
    [403, "/access-denied"],
  ])("redirects HTTP %s without turning it into a service failure", async (status, path) => {
    session();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
    await expect(adminApi("/api/admin/users")).rejects.toThrow(`NEXT_REDIRECT:${path}`);
  });

  it("redirects missing cookies before contacting the API", async () => {
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [],
    } as unknown as Awaited<ReturnType<typeof cookies>>);
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(adminApi("/api/admin/users")).rejects.toThrow(
      "NEXT_REDIRECT:/login?state=expired",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports an upstream connection failure as unavailable", async () => {
    session();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("private upstream failure"));
    expect(await adminApi("/api/admin/users")).toEqual({ status: 503, json: null });
  });

  it("returns successful data using an uncached session request", async () => {
    session();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: { items: [] } }));
    expect(await adminApi("/api/admin/users")).toEqual({
      status: 200,
      json: { data: { items: [] } },
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        cache: "no-store",
        headers: { accept: "application/json", cookie: "session=fixture" },
      }),
    );
  });
});
