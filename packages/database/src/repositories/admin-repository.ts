import type { PrismaClient } from "../generated/prisma/client.js";
import { getPrismaClient } from "../client.js";
import { DatabaseError } from "../errors.js";

/** Deliberate operator bootstrap only; never called by registration or HTTP routes. */
export class AdminRepository {
  constructor(private readonly db: PrismaClient = getPrismaClient()) {}

  findPrincipalForUser(userId: string) {
    return this.db.adminPrincipal.findUnique({ where: { userId } });
  }

  async bootstrap(userId: string) {
    if (!/^[A-Za-z0-9_-]{1,255}$/u.test(userId)) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "An existing user ID is required.");
    }
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mandatepay:admin-bootstrap'))`;
      const existing = await tx.adminPrincipal.findUnique({ where: { singletonKey: "main" } });
      if (existing && existing.userId !== userId) {
        throw new DatabaseError("CONFLICT", "The main administrator is already configured.");
      }
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { emailVerified: true },
      });
      if (!user?.emailVerified) {
        throw new DatabaseError(
          "INVALID_STATE",
          "Bootstrap requires an existing verified account.",
        );
      }
      if (existing) return { principal: existing, created: false };
      const principal = await tx.adminPrincipal.create({ data: { userId, singletonKey: "main" } });
      return { principal, created: true };
    });
  }
}
