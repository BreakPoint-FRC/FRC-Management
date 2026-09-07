import { randomBytes } from "node:crypto";

import { Client } from "pg";

/**
 * The variable that points the integration suite at a Postgres server.
 *
 * It is a *server* URL, not the URL of the database under test: the suite
 * creates a throwaway database of its own on that server, migrates it from
 * empty, and drops it again when the run ends. Pointing it at a database that
 * matters is therefore safe -- nothing is ever written to the database named in
 * the URL, only to the one created beside it.
 *
 * Deliberately not DATABASE_URL. That one is the development database, and a
 * suite that truncates every table between tests must not be one typo away
 * from a season's worth of real work.
 */
export const TEST_DATABASE_URL_VAR = "TEST_DATABASE_URL";

/** Name of the throwaway database, unique per run so two runs cannot collide. */
export function ephemeralDatabaseName(): string {
  return `breakpoint_test_${process.pid}_${randomBytes(4).toString("hex")}`;
}

/** The same server, with the database part replaced. */
export function withDatabase(serverUrl: string, databaseName: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function withClient<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * Whether the server answers at all.
 *
 * A missing server is not a test failure -- a contributor without Docker still
 * gets a green `pnpm test` -- so the caller skips the suite instead. Returns
 * the reason rather than throwing so it can be printed.
 */
export async function serverUnreachableReason(url: string): Promise<string | null> {
  try {
    await withClient(url, async (client) => client.query("SELECT 1"));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function createDatabase(serverUrl: string, name: string): Promise<void> {
  // Identifier, not a value, so it cannot be a bound parameter. The name is
  // generated above from a pid and hex, never from input.
  await withClient(serverUrl, (client) => client.query(`CREATE DATABASE "${name}"`));
}

export async function dropDatabase(serverUrl: string, name: string): Promise<void> {
  await withClient(serverUrl, (client) =>
    // FORCE terminates whatever is still connected. A test that leaked a client
    // should not leave a database behind on the server for the next run to
    // trip over.
    client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  );
}

/**
 * Empties every table the migrations created, in one statement.
 *
 * One TRUNCATE rather than a database per test: replaying twenty-odd
 * migrations for each test would cost minutes, and RESTART IDENTITY CASCADE
 * leaves the schema in the state a fresh migration produces. The fixture is
 * rebuilt after it, so every test still starts from the same known rows.
 *
 * `_prisma_migrations` is excluded on purpose -- clearing it would make the
 * database look unmigrated to anything that asks.
 */
export class TestDatabase {
  private readonly client: Client;
  private truncateStatement: string | null = null;

  constructor(private readonly url: string) {
    this.client = new Client({ connectionString: url });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async close(): Promise<void> {
    await this.client.end();
  }

  async truncateAll(): Promise<void> {
    if (this.truncateStatement === null) {
      const { rows } = await this.client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
      );
      if (rows.length === 0) {
        throw new Error(
          `No tables found in ${this.url}. Did "prisma migrate deploy" actually run?`
        );
      }
      this.truncateStatement = `TRUNCATE TABLE ${rows
        .map((row) => `"public"."${row.tablename}"`)
        .join(", ")} RESTART IDENTITY CASCADE`;
    }

    await this.client.query(this.truncateStatement);
  }

  /** Raw SQL, for the tests that have to write a row no service would write. */
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
    return this.client.query<T>(sql, values);
  }
}
