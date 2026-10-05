import { createPrismaClient } from "../src/client.js";
import { AdminRepository } from "../src/repositories/admin-repository.js";
import { isDatabaseError } from "../src/errors.js";

const userId = process.env.MANDATEPAY_ADMIN_USER_ID;
if (!userId) {
  console.error("Set MANDATEPAY_ADMIN_USER_ID to an existing verified user ID.");
  process.exitCode = 1;
} else {
  const database = createPrismaClient();
  try {
    const result = await new AdminRepository(database).bootstrap(userId);
    console.info(
      result.created
        ? "Main administrator configured."
        : "Main administrator already configured; no change.",
    );
  } catch (error) {
    console.error(
      isDatabaseError(error)
        ? error.message
        : "Admin bootstrap failed; check database configuration.",
    );
    process.exitCode = 1;
  } finally {
    await database.$disconnect();
  }
}
