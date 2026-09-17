import { Pool } from "pg";

const CONNECTION_TIMEOUT_MS = 1_750;
const QUERY_TIMEOUT_MS = 1_750;
const STATEMENT_TIMEOUT_MS = 1_500;

export interface ReadinessProbe {
  check(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A database probe isolated from the application's Prisma pool.
 *
 * The HTTP route has its own two-second deadline, but racing a Prisma promise
 * does not cancel the underlying database work. This one-connection pool adds
 * driver- and server-side limits as well: a dead socket or stuck query is
 * discarded before the next Compose healthcheck, and public traffic could
 * never make readiness consume an unbounded number of connections even if a
 * reverse proxy were configured incorrectly.
 */
export function createReadinessProbe(
  connectionString: string,
  onIdleError: (error: Error) => void
): ReadinessProbe {
  const pool = new Pool({
    connectionString,
    application_name: "frc-management-readiness",
    max: 1,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
  });

  // node-postgres emits an EventEmitter "error" for an idle client failure.
  // Without a listener Node terminates the whole API process.
  pool.on("error", onIdleError);

  let closed = false;

  return {
    async check() {
      await pool.query("SELECT 1");
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
