import { defineConfig } from "vitest/config";

// The integration suite: the same app, on a Postgres built from empty by the
// migration chain. globalSetup creates the database, migrates it, and drops it
// again; if there is no server to build it on, it provides null instead and
// every suite skips itself with a warning rather than failing.
//
// See the README's Testing section for TEST_DATABASE_URL.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/harness/global-setup.ts"],
    // One database for the whole run, emptied between tests. Files running in
    // parallel would be truncating each other's fixture mid-test.
    fileParallelism: false,
    // A real round trip per assertion, and an argon2 hash on the first test of
    // each file. Neither is slow; both are slower than an in-memory stub.
    testTimeout: 30_000,
    // Covers creating the database and replaying every migration into it.
    hookTimeout: 120_000,
  },
});
