import { defineConfig } from "vitest/config";

// The unit suites: every module's `.test.ts` next to the code it covers, all of
// them against a stub Prisma client and app.inject, so they need neither a
// database nor a socket.
//
// `include` is narrowed to src on purpose. The integration suite lives in
// test/integration and needs a migrated Postgres, so it has its own config --
// vitest.integration.config.ts -- and must not be picked up here.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
