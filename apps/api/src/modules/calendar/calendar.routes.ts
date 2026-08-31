import type { FastifyInstance } from "fastify";

import { authorize, canPerform } from "../../lib/authorize";
import { requireTeam } from "../../lib/tenant";
import { calendarQuerySchema } from "./calendar.schema";
import { createCalendarService } from "./calendar.service";

/**
 * Mounted at /calendar.
 *
 *   GET /calendar ?from&to&seasonId&groupId -> 200 { items, season } | 400 | 401 | 403
 *
 * One endpoint, and no mutations. The calendar has no records of its own: every
 * entry is a date read off a meeting or a task at request time, so moving a due
 * date on the task page has already moved it here. Creating something dated is
 * done where it lives -- POST /meetings, POST /tasks.
 *
 * The response is not paginated. See calendar.schema.ts for why a window beats
 * page/pageSize for this shape.
 */
export async function calendarRoutes(app: FastifyInstance) {
  const service = createCalendarService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // -> 200 | 400 | 401 | 403
  app.get("/", async (req) => {
    const query = calendarQuerySchema.parse(req.query);

    // Reading the whole team's calendar is a team-wide permission; reading one
    // department's is not. Same rule as GET /tasks, so a member with only a
    // group role has to pass groupId to get an answer.
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "CALENDAR",
      action: "read",
      groupId: query.groupId,
    });

    // CALENDAR grants the view, not the data.
    //
    // Every entry on this page belongs to another module, so each source is
    // filled only as far as the account could already read it directly.
    // Without this the calendar would be a side door: an account with CALENDAR
    // but not MEETINGS would learn every meeting title on the team by asking
    // the wrong endpoint. Denied sources come back empty rather than as a 403,
    // because a member who may see tasks and not meetings still has a calendar
    // worth showing.
    const [meetings, tasks] = await Promise.all([
      canPerform(app.prisma, {
        accountId: req.account.id,
        tool: "MEETINGS",
        action: "read",
        groupId: query.groupId,
      }),
      canPerform(app.prisma, {
        accountId: req.account.id,
        tool: "TASKS",
        action: "read",
        groupId: query.groupId,
      }),
    ]);

    // The season window rides along under CALENDAR read rather than SEASONS.
    // SEASONS is an administrative tool most members do not hold, and this is a
    // name and two dates that GANTT read already shows on every board row --
    // gating it there would grey out the calendar for almost everyone to
    // protect something already on screen.
    return service.range(requireTeam(req.account), query, { meetings, tasks });
  });
}
