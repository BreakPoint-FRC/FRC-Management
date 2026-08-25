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
const PRISMA_ERROR_STATUS: Record<string, { status: number; message: string }> = {
  P2025: { status: 404, message: "Resource not found" },
  P2002: { status: 409, message: "A record with that value already exists" },
  P2003: { status: 400, message: "Referenced record does not exist" },
};

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  404: "Not Found",
  409: "Conflict",
};

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
          error: STATUS_TEXT[mapped.status],
          message: mapped.message,
        });
      }
    }

    // Fastify's own client errors (bad JSON, unknown route, ...) are safe to surface.
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        statusCode: error.statusCode,
        error: STATUS_TEXT[error.statusCode] ?? "Error",
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
