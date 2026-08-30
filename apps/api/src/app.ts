import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";
import { Prisma, type PrismaClient } from "@breakpoint/db";

import authPlugin from "./plugins/auth";
import corsPlugin from "./plugins/cors";
import prismaPlugin from "./plugins/prisma";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./lib/http-errors";

import { authRoutes } from "./modules/auth/auth.routes";
import { accountsRoutes } from "./modules/accounts/accounts.routes";
import { groupsRoutes } from "./modules/groups/groups.routes";
import { rolesRoutes } from "./modules/roles/roles.routes";
import { toolsRoutes } from "./modules/tools/tools.routes";
import { seasonsRoutes } from "./modules/seasons/seasons.routes";
import { tasksRoutes } from "./modules/tasks/tasks.routes";
import { meetingsRoutes } from "./modules/meetings/meetings.routes";
import { financeRoutes } from "./modules/finance/finance.routes";
import { sponsorsRoutes } from "./modules/sponsors/sponsors.routes";
import { ganttRoutes } from "./modules/gantt/gantt.routes";
import { calendarRoutes } from "./modules/calendar/calendar.routes";

// Prisma error codes we can turn into a meaningful status instead of a 500.
const PRISMA_ERROR_STATUS: Record<string, { status: number; message: string }> = {
  P2025: { status: 404, message: "Resource not found" },
  P2002: { status: 409, message: "A record with that value already exists" },
  P2003: { status: 400, message: "Referenced record does not exist" },
};

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  429: "Too Many Requests",
};

// Errors that carry their own status and a message safe to show a client. Each
// is checked by class rather than by a `statusCode` property so an unrelated
// library error that happens to have one cannot pick its own status.
const DOMAIN_ERRORS = [
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
] as const;

/**
 * Checked structurally rather than with `instanceof ZodError`.
 *
 * Schemas built here and schemas imported from @breakpoint/types can come from
 * two different copies of zod's module graph -- the API is loaded as ESM under
 * vitest while the built package is CommonJS, so each gets its own ZodError
 * class and `instanceof` is false across the two. That turned every validation
 * failure on a schema derived from @breakpoint/types (anything extending
 * paginationSchema) into a 500 instead of a 400.
 *
 * The shape is the contract, so test the shape. This also holds if a second
 * copy of zod ever appears in the tree for an unrelated reason.
 */
function isZodError(error: unknown): error is ZodError {
  return (
    error instanceof ZodError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "ZodError" &&
      Array.isArray((error as { issues?: unknown }).issues))
  );
}

export function buildApp(opts: { prisma?: PrismaClient } = {}) {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, request, reply) => {
    if (isZodError(error)) {
      return reply.code(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid request",
        issues: error.issues,
      });
    }

    for (const DomainError of DOMAIN_ERRORS) {
      if (error instanceof DomainError) {
        return reply.code(error.statusCode).send({
          statusCode: error.statusCode,
          error: STATUS_TEXT[error.statusCode] ?? "Error",
          message: error.message,
        });
      }
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

    // Fastify's own client errors (bad JSON, unknown route, rate limit, ...)
    // are safe to surface.
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        statusCode: error.statusCode,
        error: STATUS_TEXT[error.statusCode] ?? "Error",
        message: error.message,
      });
    }

    // Anything else is unexpected: log it server-side and tell the client
    // nothing. Sending `error` directly would leak Prisma internals and
    // absolute file paths.
    request.log.error(error);
    return reply.code(500).send({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal Server Error",
    });
  });

  app.register(prismaPlugin, { prisma: opts.prisma });
  app.register(corsPlugin);

  // Registered globally but configured per route: only /auth/login opts in.
  // A blanket limit would throttle a lead doing ordinary work during build
  // season, which is not the attack anyone is defending against.
  app.register(rateLimit, { global: false });
  app.register(authPlugin);

  app.get("/health", async () => ({ status: "ok" }));

  app.register(authRoutes, { prefix: "/auth" });

  // Identity and access.
  app.register(accountsRoutes, { prefix: "/accounts" });
  app.register(groupsRoutes, { prefix: "/groups" });
  app.register(rolesRoutes, { prefix: "/roles" });
  app.register(toolsRoutes, { prefix: "/tools" });

  // Operational modules. Every one of them is scoped to a season.
  app.register(seasonsRoutes, { prefix: "/seasons" });
  app.register(tasksRoutes, { prefix: "/tasks" });
  app.register(meetingsRoutes, { prefix: "/meetings" });
  app.register(financeRoutes, { prefix: "/finance" });
  app.register(sponsorsRoutes, { prefix: "/sponsors" });
  app.register(ganttRoutes, { prefix: "/gantt" });
  app.register(calendarRoutes, { prefix: "/calendar" });

  return app;
}
