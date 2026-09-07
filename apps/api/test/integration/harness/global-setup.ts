import { spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnvFile } from "dotenv";
import type { GlobalSetupContext } from "vitest/node";

import {
  TEST_DATABASE_URL_VAR,
  createDatabase,
  dropDatabase,
  ephemeralDatabaseName,
  serverUnreachableReason,
  withDatabase,
} from "./database";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(harnessDir, "..", "..", "..", "..", "..");
const dbPackageDir = join(repoRoot, "packages", "db");
const integrationTestsRequiredVar = "INTEGRATION_TESTS_REQUIRED";

// The repository keeps one .env at the root, shared by every workspace, and
// `vitest run` -- unlike the dev scripts -- does not go through dotenv-cli. So
// the file is read here. `override` is left off: a variable already set in the
// environment (CI, or a one-off shell) wins over the file.
loadEnvFile({ path: join(repoRoot, ".env") });

function unavailable(reason: string): void {
  const help =
    `[integration] These tests need a Postgres server. Start one with ` +
    `\`docker compose up -d\` and set ${TEST_DATABASE_URL_VAR} in .env ` +
    `(see .env.example and the README's Testing section).`;

  // A contributor may deliberately work without Postgres, but a green CI run
  // must prove that the integration suite actually ran. Otherwise a broken URL
  // or credential would silently remove the protection this suite exists for.
  if (process.env[integrationTestsRequiredVar] === "true") {
    throw new Error(`[integration] required but unavailable: ${reason}\n${help}`);
  }

  console.warn(`\n[integration] skipped: ${reason}\n${help}\n`);
}

/**
 * Builds the database the integration suite runs against, once per run.
 *
 * It is created empty and migrated with the same `prisma migrate deploy` CI
 * uses, which means every run replays the whole migration chain from nothing --
 * the exact path docs/migrations.md says a local `db:deploy` against an
 * already-populated database does not prove.
 */
export default async function setup({ provide }: GlobalSetupContext) {
  const serverUrl = process.env[TEST_DATABASE_URL_VAR];

  if (!serverUrl) {
    unavailable(`${TEST_DATABASE_URL_VAR} is not set`);
    provide("integrationDatabaseUrl", null);
    return;
  }

  const unreachable = await serverUnreachableReason(serverUrl);
  if (unreachable) {
    unavailable(`${TEST_DATABASE_URL_VAR} is set but the server did not answer (${unreachable})`);
    provide("integrationDatabaseUrl", null);
    return;
  }

  const name = ephemeralDatabaseName();
  await createDatabase(serverUrl, name);

  const databaseUrl = withDatabase(serverUrl, name);
  try {
    migrate(databaseUrl);
  } catch (error) {
    // A half-migrated database is worse than none: drop it before rethrowing so
    // the next run is not looking at a leftover.
    await dropDatabase(serverUrl, name);
    throw error;
  }

  provide("integrationDatabaseUrl", databaseUrl);

  return async () => {
    await dropDatabase(serverUrl, name);
  };
}

/**
 * Runs `prisma migrate deploy` against the throwaway database.
 *
 * The CLI is reached through packages/db's own .bin directory rather than
 * `pnpm --filter`, because that is one process instead of two and needs no
 * shell quoting on a path that may contain spaces. prisma.config.ts loads the
 * root .env with dotenv, which does not overwrite an existing variable, so the
 * DATABASE_URL passed here is the one it uses.
 */
function migrate(databaseUrl: string): void {
  const binDir = join(dbPackageDir, "node_modules", ".bin");

  // One command string rather than a command plus an args array: on Windows the
  // shim is prisma.CMD, which Node will only run through a shell, and passing
  // args alongside `shell: true` is deprecated (DEP0190). Nothing here comes
  // from input, and the binary is found on the PATH below rather than by a path
  // that could contain spaces.
  const result = spawnSync("prisma migrate deploy", {
    cwd: dbPackageDir,
    shell: true,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  });

  if (result.status !== 0) {
    throw new Error(
      `prisma migrate deploy failed (exit ${result.status}).\n` +
        `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    );
  }
}
