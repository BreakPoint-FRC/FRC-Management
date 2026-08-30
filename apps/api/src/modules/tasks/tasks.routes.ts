import type { FastifyInstance } from "fastify";
import { paginationSchema } from "@breakpoint/types";

import { authorize } from "../../lib/authorize";
import { NotFoundError } from "../../lib/http-errors";
import {
  createTaskSchema,
  listTasksQuerySchema,
  replaceAssigneesSchema,
  updateTaskSchema,
} from "./tasks.schema";
import { createTasksService } from "./tasks.service";

/**
 * Mounted at /tasks.
 *
 *   GET    /tasks     ?page&pageSize&seasonId&groupId&status&priority&assigneeId&open
 *                                                  -> 200 paginated | 400 | 401 | 403
 *   GET    /tasks/:id                              -> 200 | 401 | 403 | 404
 *   GET    /tasks/:id/activity ?page&pageSize      -> 200 paginated | 401 | 403 | 404
 *   POST   /tasks     { name, groupId?, seasonId?, description?, startDate?,
 *                       dueDate?, status?, priority?, assigneeIds? }
 *                                                  -> 201 | 400 | 401 | 403 | 409 no active season
 *   PATCH  /tasks/:id { name?, groupId?, ... }     -> 200 | 400 | 401 | 403 | 404
 *   PUT    /tasks/:id/assignees { accountIds: [] } -> 200 | 400 | 401 | 403 | 404
 *   DELETE /tasks/:id                              -> 204 | 401 | 403 | 404
 *
 * There is no /todos. A todo list is GET /tasks?open=true, or a status filter --
 * the same rows, filtered, so the two views can never disagree about what is
 * outstanding.
 *
 * Every mutation is authorized against the group the task is *in*, read from
 * the stored row rather than the request body: otherwise a member could move a
 * task into a group they have no permission over by putting that group's id in
 * the payload.
 */
export async function tasksRoutes(app: FastifyInstance) {
  const service = createTasksService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  /** Loads the task and authorizes the action against the group it belongs to. */
  const authorizeExisting = async (
    accountId: string,
    taskId: string,
    action: "read" | "update" | "delete"
  ) => {
    const task = await service.groupOf(taskId);
    if (!task) throw new NotFoundError("Gorev bulunamadi");

    await authorize(app.prisma, {
      accountId,
      tool: "TASKS",
      action,
      groupId: task.groupId,
    });
    return task;
  };

  // -> 200 | 400 | 401 | 403
  app.get("/", async (req) => {
    const query = listTasksQuerySchema.parse(req.query);
    // Listing "all tasks" is a team-wide read; listing one group's is not. The
    // filter therefore decides which permission is required, and a member with
    // only a group role has to pass groupId to get an answer.
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: query.open ? "TODO" : "TASKS",
      action: "read",
      groupId: query.groupId,
    });
    return service.list(query);
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorizeExisting(req.account.id, id, "read");

    const task = await service.getById(id);
    if (!task) throw new NotFoundError("Gorev bulunamadi");
    return task;
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id/activity", async (req) => {
    const { id } = req.params as { id: string };
    const task = await service.groupOf(id);
    if (!task) throw new NotFoundError("Gorev bulunamadi");

    // The history is its own tool: seeing a task is not the same permission as
    // seeing who changed what about it.
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "TASK_LOGS",
      action: "read",
      groupId: task.groupId,
    });

    return service.activity(id, paginationSchema.parse(req.query));
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/", async (req, reply) => {
    const input = createTaskSchema.parse(req.body);
    // On create there is no stored row yet, so the body is the only source for
    // the group -- and it is checked before anything is written.
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "TASKS",
      action: "create",
      groupId: input.groupId,
    });

    const task = await service.create(input, req.account.id);
    reply.code(201).send(task);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = updateTaskSchema.parse(req.body);

    await authorizeExisting(req.account.id, id, "update");

    // Moving a task into a different group needs permission over the
    // destination too, or this would be a way to push work into a department
    // you have no say over.
    if (input.groupId !== undefined) {
      await authorize(app.prisma, {
        accountId: req.account.id,
        tool: "TASKS",
        action: "update",
        groupId: input.groupId,
      });
    }

    return service.update(id, input, req.account.id);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.put("/:id/assignees", async (req) => {
    const { id } = req.params as { id: string };
    await authorizeExisting(req.account.id, id, "update");

    return service.replaceAssignees(
      id,
      replaceAssigneesSchema.parse(req.body),
      req.account.id
    );
  });

  // -> 204 | 401 | 403 | 404
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await authorizeExisting(req.account.id, id, "delete");

    await service.remove(id);
    reply.code(204).send();
  });
}
