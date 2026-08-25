import { STATUS_CODES } from "node:http";
import Fastify from "fastify";
import { ZodError } from "zod";
import { Prisma, type PrismaClient } from "@breakpoint/db";

import prismaPlugin from "./plugins/prisma";
import corsPlugin from "./plugins/cors";
import { NotFoundError } from "./lib/http-errors";

import { membersRoutes } from "./modules/members/members.routes";
import { groupsRoutes } from "./modules/groups/groups.routes";
import { meetingsRoutes } from "./modules/meetings/meetings.routes";
import { tasksRoutes } from "./modules/tasks/tasks.routes";
import { financeRoutes } from "./modules/finance/finance.routes";

// Prisma error codes we can turn into a meaningful status instead of a 500.
//
// P2003 is a foreign key violation in BOTH directions, and 400 only fits one of
// them: an insert naming an id that is not there. Postgres raises the same code
// when a delete is blocked by an ON DELETE RESTRICT child — four such keys exist
// (GroupMember x2, Attendance x2) — and there the referenced record does exist,
// so 409 would be the honest answer. Prisma does not hand back enough to tell
// the two apart reliably, and no route reaches the restrict case today: members
// are soft-deleted, meetings have no delete, and groups.remove clears its
// memberships first. Adding a hard delete anywhere means revisiting this row
// rather than inheriting a message that says the opposite of what happened.
const PRISMA_ERROR_STATUS: Record<string, { status: number; message: string }> = {
  P2025: { status: 404, message: "Resource not found" },
  P2002: { status: 409, message: "A record with that value already exists" },
  P2003: { status: 400, message: "Referenced record does not exist" },
};

// Node's own reason phrases, rather than a hand-kept map: a short map covers
// only the statuses someone remembered, and every other client error (415 on a
// bad Content-Type, 413, 405) then reports a meaningless `error: "Error"`.
const statusText = (status: number) => STATUS_CODES[status] ?? "Error";

export function buildApp(opts: { prisma?: PrismaClient } = {}) {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid request",
        issues: error.issues,
      });
    }

    if (error instanceof NotFoundError) {
      return reply.code(404).send({
        statusCode: 404,
        error: "Not Found",
        message: error.message,
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = PRISMA_ERROR_STATUS[error.code];
      if (mapped) {
        return reply.code(mapped.status).send({
          statusCode: mapped.status,
          error: statusText(mapped.status),
          message: mapped.message,
        });
      }
    }

    // Fastify's own client errors (bad JSON, wrong content type, ...) are safe to
    // surface. Unknown routes never arrive here — they go to Fastify's own
    // not-found handler, which already answers in this shape.
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        statusCode: error.statusCode,
        error: statusText(error.statusCode),
        message: error.message,
      });
    }

    // Anything else is unexpected: log it server-side and tell the client nothing.
    // Sending `error` directly would leak Prisma internals and absolute file paths.
    request.log.error(error);
    return reply.code(500).send({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal Server Error",
    });
  });

  app.register(prismaPlugin, { prisma: opts.prisma });
  app.register(corsPlugin);

  app.get("/health", async () => ({ status: "ok" }));

  app.register(membersRoutes, { prefix: "/members" });
  app.register(groupsRoutes, { prefix: "/groups" });
  app.register(meetingsRoutes, { prefix: "/meetings" });
  app.register(tasksRoutes, { prefix: "/tasks" });
  app.register(financeRoutes, { prefix: "/finance" });

  return app;
}
