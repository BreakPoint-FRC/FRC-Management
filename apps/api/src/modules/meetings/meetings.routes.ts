import type { FastifyInstance } from "fastify";
import {
  createMeetingSchema,
  rollCallSchema,
  updateReportSchema,
} from "./meetings.schema";
import { createMeetingsService } from "./meetings.service";
import { NotFoundError } from "../../lib/http-errors";

export async function meetingsRoutes(app: FastifyInstance) {
  const service = createMeetingsService(app.prisma);

  app.get("/", async () => service.list());

  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    const meeting = await service.getById(id);
    if (!meeting) throw new NotFoundError("Meeting not found");
    return meeting;
  });

  app.post("/", async (req, reply) => {
    const input = createMeetingSchema.parse(req.body);
    const meeting = await service.create(input);
    reply.code(201).send(meeting);
  });

  app.put("/:id/report", async (req) => {
    const { id } = req.params as { id: string };
    const input = updateReportSchema.parse(req.body);
    return service.updateReport(id, input);
  });

  app.put("/:id/roll-call", async (req) => {
    const { id } = req.params as { id: string };
    const input = rollCallSchema.parse(req.body);
    return service.recordAttendance(id, input);
  });
}
