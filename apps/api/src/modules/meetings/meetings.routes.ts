import type { FastifyInstance } from "fastify";

import { authorize } from "../../lib/authorize";
import { NotFoundError } from "../../lib/http-errors";
import {
  createMeetingSchema,
  listMeetingsQuerySchema,
  recordAttendanceSchema,
  updateMeetingSchema,
} from "./meetings.schema";
import { createMeetingsService } from "./meetings.service";

/**
 * Mounted at /meetings.
 *
 *   GET    /meetings          ?page&pageSize&seasonId&groupId -> 200 paginated | 400 | 401 | 403
 *   GET    /meetings/:id                                      -> 200 | 401 | 403 | 404
 *   POST   /meetings   { title, meetingDate, groupId?, seasonId?, body? }
 *                                                             -> 201 | 400 | 401 | 403 | 409 no active season
 *   PATCH  /meetings/:id { title?, body?, meetingDate?, groupId? }
 *                                                             -> 200 | 400 | 401 | 403 | 404
 *   PUT    /meetings/:id/attendance { attendance: [{ accountId, status, note? }] }
 *                                                             -> 200 | 400 | 401 | 403 | 404
 *   DELETE /meetings/:id                                      -> 204 | 401 | 403 | 404
 *
 * The report body is a field on the meeting, edited with PATCH like any other.
 * Roll call is separate because it is a set with its own shape, and because
 * writing a report and taking attendance are done by different people at
 * different times.
 */
export async function meetingsRoutes(app: FastifyInstance) {
  const service = createMeetingsService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // Authorized against the group the meeting is in, read from the stored row
  // rather than the body -- same reason as tasks.
  const authorizeExisting = async (
    accountId: string,
    meetingId: string,
    action: "read" | "update" | "delete"
  ) => {
    const meeting = await service.groupOf(meetingId);
    if (!meeting) throw new NotFoundError("Toplanti bulunamadi");

    await authorize(app.prisma, {
      accountId,
      tool: "MEETINGS",
      action,
      groupId: meeting.groupId,
    });
    return meeting;
  };

  // -> 200 | 400 | 401 | 403
  app.get("/", async (req) => {
    const query = listMeetingsQuerySchema.parse(req.query);
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "MEETINGS",
      action: "read",
      groupId: query.groupId,
    });
    return service.list(query);
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorizeExisting(req.account.id, id, "read");

    const meeting = await service.getById(id);
    if (!meeting) throw new NotFoundError("Toplanti bulunamadi");
    return meeting;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/", async (req, reply) => {
    const input = createMeetingSchema.parse(req.body);
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "MEETINGS",
      action: "create",
      groupId: input.groupId,
    });

    const meeting = await service.create(input, req.account.id);
    reply.code(201).send(meeting);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = updateMeetingSchema.parse(req.body);

    await authorizeExisting(req.account.id, id, "update");

    if (input.groupId !== undefined) {
      await authorize(app.prisma, {
        accountId: req.account.id,
        tool: "MEETINGS",
        action: "update",
        groupId: input.groupId,
      });
    }

    return service.update(id, input);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.put("/:id/attendance", async (req) => {
    const { id } = req.params as { id: string };
    await authorizeExisting(req.account.id, id, "update");

    return service.recordAttendance(id, recordAttendanceSchema.parse(req.body));
  });

  // -> 204 | 401 | 403 | 404
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await authorizeExisting(req.account.id, id, "delete");

    await service.remove(id);
    reply.code(204).send();
  });
}
