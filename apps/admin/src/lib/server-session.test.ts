import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
import { readAdminSession } from "./server-session";
describe("admin server session guard", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("does not treat absent cookies as a session or contact the API", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    expect(await readAdminSession("")).toEqual({ status: "expired" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("distinguishes unauthorized, forbidden and service failure without granting access", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const [status, result] of [
      [401, "expired"],
      [403, "denied"],
      [503, "unavailable"],
    ] as const) {
      fetcher.mockResolvedValueOnce(new Response(null, { status }));
      expect(await readAdminSession("session=fixture")).toEqual({ status: result });
    }
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ data: { token: "unsafe" } })));
    expect(await readAdminSession("session=fixture")).toEqual({ status: "unavailable" });
    fetcher.mockRejectedValueOnce(new Error("upstream-secret"));
    expect(await readAdminSession("session=fixture")).toEqual({ status: "unavailable" });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      cache: "no-store",
      headers: { cookie: "session=fixture" },
    });
  });
});
