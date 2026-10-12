import { describe, expect, it } from "vitest";
import { AuditEventType, PaymentStatus } from "@mandatepay/database";
import { ADMIN_DOMAIN_EVENT_TYPES, ADMIN_PAYMENT_STATUSES } from "@mandatepay/shared";

// The admin contracts mirror Prisma enums by hand. A value missing from the mirror makes admin
// list parsing reject whole pages, so every database value must be listed.
describe("admin contract catalogues", () => {
  it("lists every persisted audit event type", () => {
    expect([...ADMIN_DOMAIN_EVENT_TYPES].sort()).toEqual(Object.values(AuditEventType).sort());
  });

  it("lists every persisted payment status", () => {
    expect([...ADMIN_PAYMENT_STATUSES].sort()).toEqual(Object.values(PaymentStatus).sort());
  });
});
