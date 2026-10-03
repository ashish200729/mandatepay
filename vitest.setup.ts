import { afterEach, vi } from "vitest";

process.env.TZ = "UTC";

afterEach(() => {
  vi.restoreAllMocks();
});
