import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { proxyAdmin } from "./proxy";
import { parseAdminAuditResponse } from "./audit";

const uuid = "11111111-1111-4111-8111-111111111111";
const event = {
  id: uuid,
  actorAdminId: null,
  actorUserId: null,
  role: null,
  action: "ADMIN_LOGIN_FAILED",
  targetType: "ADMIN_AUTH",
  targetId: "main",
  reason: "Administrator credential sign-in rejected.",
  requestId: uuid,
  correlationId: uuid,
  actionId: null,
  beforeSummaryJson: null,
  afterSummaryJson: { token: "private-token" },
  result: "FAILURE",
  errorCode: "ADMIN_SIGN_IN_REJECTED",
  createdAt: "2026-10-05T00:00:00.000Z",
  password: "private-password",
};
describe("admin audit BFF", () => {
  it("projects bounded list/detail data and rejects malformed or unsafe rows", () => {
    expect(JSON.stringify(parseAdminAuditResponse({ data: event }, true))).not.toMatch(
      /private-token|private-password/u,
    );
    expect(
      parseAdminAuditResponse({ data: [event], page: { nextCursor: null, limit: 50 } }, false)?.page
        ?.limit,
    ).toBe(50);
    expect(
      parseAdminAuditResponse(
        {
          data: [{ ...event, errorCode: "private-provider-message" }],
          page: { nextCursor: null, limit: 50 },
        },
        false,
      ),
    ).toBeNull();
    expect(
      parseAdminAuditResponse({ data: [event], page: { nextCursor: null, limit: 101 } }, false),
    ).toBeNull();
  });
  it("forwards only audit GET/HEAD paths and valid single-valued filters, with safe trace headers", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [event],
          page: { nextCursor: null, limit: 2 },
          requestId: uuid,
          token: "private-token",
        }),
        {
          headers: {
            "x-request-id": uuid,
            "x-correlation-id": uuid,
            "set-cookie": "private-cookie",
          },
        },
      ),
    );
    const result = await proxyAdmin(
      new Request("http://localhost:3001/api/admin/audit?limit=2&action=ADMIN_LOGIN_FAILED", {
        headers: { "x-correlation-id": uuid },
      }),
      { path: ["audit"] },
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("x-request-id")).toBe(uuid);
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(await result.text()).not.toContain("private-token");
    expect(String(fetcher.mock.calls[0]![0])).toContain(
      "/api/admin/audit?limit=2&action=ADMIN_LOGIN_FAILED",
    );
    fetcher.mockClear();
    for (const query of [
      "limit=101",
      "limit=1&limit=2",
      "token=private",
      "action=UNKNOWN",
      "targetId=fixture",
    ])
      expect(
        (
          await proxyAdmin(new Request("http://localhost:3001/api/admin/audit?" + query), {
            path: ["audit"],
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await proxyAdmin(
          new Request("http://localhost:3001/api/admin/audit", { method: "POST", body: "{}" }),
          { path: ["audit"] },
        )
      ).status,
    ).toBe(405);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ data: event, requestId: uuid })));
    expect(
      (
        await proxyAdmin(new Request(`http://localhost:3001/api/admin/audit/${uuid}`), {
          path: ["audit", uuid],
        })
      ).status,
    ).toBe(200);
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: "ADMIN_TARGET_NOT_FOUND", message: "private" } }),
        { status: 404 },
      ),
    );
    expect(
      (
        await proxyAdmin(new Request(`http://localhost:3001/api/admin/audit/${uuid}`), {
          path: ["audit", uuid],
        })
      ).status,
    ).toBe(404);
  });
});
