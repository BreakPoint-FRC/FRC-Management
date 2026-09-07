import { afterAll, beforeAll, beforeEach, describe, inject } from "vitest";
import { createPrismaClient, type PrismaClient } from "@breakpoint/db";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../../../src/app";

import { TestDatabase } from "./database";
import { seedBaseline, type Baseline } from "./fixture";

export { FIXTURE_PASSWORD } from "./fixture";
export type { Baseline, TeamFixture } from "./fixture";

/**
 * The throwaway database globalSetup built, or null when there was no server to
 * build it on.
 */
export const integrationDatabaseUrl = inject("integrationDatabaseUrl");

/**
 * `describe`, or `describe.skip` when there is no database.
 *
 * Skipping rather than failing is what keeps `pnpm test` green for a
 * contributor who has not started Postgres yet. CI always has it -- the
 * workflow copies .env.example, which sets TEST_DATABASE_URL to the service
 * container -- so the suite genuinely runs there.
 */
export const describeIntegration = integrationDatabaseUrl ? describe : describe.skip;

export interface IntegrationContext {
  /** Built once per file against the throwaway database. */
  app: FastifyInstance;
  /** The same client the app is using, for asserting on rows directly. */
  prisma: PrismaClient;
  /** Raw SQL, for writing a row no service would write. */
  db: TestDatabase;
  /** Re-seeded before every test, so ids change between them. */
  fixture: Baseline;
}

/**
 * Wires one test file to the database: an app on top of it, a clean fixture
 * before every test.
 *
 * Call it inside `describeIntegration(...)` so that nothing connects when the
 * suite is skipped. The returned object is filled in by `beforeAll`, so read
 * its fields inside tests and hooks, never at module scope.
 *
 * The tables are emptied and the fixture rewritten before each test rather than
 * a fresh database being migrated for each: replaying the migration chain per
 * test would cost minutes, while TRUNCATE ... RESTART IDENTITY CASCADE leaves
 * exactly the schema the chain produced. Every test still starts from the same
 * rows and can write whatever it likes.
 */
export function useIntegrationDatabase(): IntegrationContext {
  const context = {} as IntegrationContext;

  beforeAll(async () => {
    const url = integrationDatabaseUrl as string;

    context.db = new TestDatabase(url);
    await context.db.connect();

    context.prisma = createPrismaClient(url);
    context.app = buildApp({ prisma: context.prisma });
    await context.app.ready();
  });

  beforeEach(async () => {
    await context.db.truncateAll();
    context.fixture = await seedBaseline(context.prisma);
  });

  afterAll(async () => {
    // app.close() runs the prisma plugin's onClose hook, which disconnects the
    // client above. Closing both would disconnect twice.
    await context.app?.close();
    await context.db?.close();
  });

  return context;
}

/** An Authorization header for an account, signed by the app under test. */
export function as(app: FastifyInstance, accountId: string): { authorization: string } {
  return { authorization: `Bearer ${app.jwt.sign({ sub: accountId })}` };
}
