import type { FastifyInstance } from "fastify";

import { createDashboardService } from "./dashboard.service";

/**
 * Mounted at /dashboard.
 *
 *   GET /dashboard -> 200 | 401
 *
 * Not gated on a tool: there is nothing to be authorized for that reading
 * your own account's summary isn't already. Every piece of data behind it is
 * read through the same TASKS/MEETINGS/ACCOUNTS/TEAMS permission checks the
 * dedicated endpoints already use -- this route just decides, from that same
 * resolved matrix, which pieces to compute at all. See dashboard.service.ts
 * for that resolution and why it reads a role's actual grants rather than its
 * name or placement.
 */
export async function dashboardRoutes(app: FastifyInstance) {
  const service = createDashboardService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // -> 200 | 401
  app.get("/", async (req) => service.summary(req.account));
}
