import type { FastifyInstance } from "fastify";

import { dashboardQuerySchema } from "./dashboard.schema";
import { createDashboardService } from "./dashboard.service";

/**
 * Mounted at /dashboard.
 *
 *   GET /dashboard?today=YYYY-MM-DD -> 200 | 400 | 401
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

  // The user's calendar day comes from the browser. The API cannot infer it
  // reliably from an instant because teams may use the app in any timezone.
  app.get("/", async (req) => {
    const { today } = dashboardQuerySchema.parse(req.query);
    return service.summary(req.account, today);
  });
}
