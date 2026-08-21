import type { FastifyInstance } from "fastify";
import { createTaskSchema, updateTaskSchema } from "./tasks.schema";
import { createTasksService } from "./tasks.service";
import { NotFoundError } from "../../lib/http-errors";

export async function tasksRoutes(app: FastifyInstance) {
  const service = createTasksService(app.prisma);

  app.get("/", async (req) => {
    const { groupId } = req.query as { groupId?: string };
    return service.list(groupId);
  });

  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    const task = await service.getById(id);
    if (!task) throw new NotFoundError("Task not found");
    return task;
  });

  app.post("/", async (req, reply) => {
    const input = createTaskSchema.parse(req.body);
    const task = await service.create(input);
    reply.code(201).send(task);
  });

  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = updateTaskSchema.parse(req.body);
    return service.update(id, input);
  });

  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await service.remove(id);
    reply.code(204).send();
  });
}
