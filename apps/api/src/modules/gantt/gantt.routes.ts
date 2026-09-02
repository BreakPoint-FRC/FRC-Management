import type { FastifyInstance } from "fastify";

import { authorize } from "../../lib/authorize";
import { requireTeam } from "../../lib/tenant";
import type { AuthenticatedAccount } from "../../plugins/auth";
import { NotFoundError } from "../../lib/http-errors";
import {
  createBoardSchema,
  listBoardsQuerySchema,
  replaceBoardTasksSchema,
  updateBoardSchema,
} from "./gantt.schema";
import { createGanttService } from "./gantt.service";

/**
 * Mounted at /gantt.
 *
 *   GET    /gantt            ?page&pageSize&seasonId&groupId -> 200 paginated | 400 | 401 | 403
 *   GET    /gantt/:id                                        -> 200 | 401 | 403 | 404
 *   POST   /gantt   { name, seasonId?, groupId? }            -> 201 | 400 | 401 | 403 | 409 duplicate name
 *   PATCH  /gantt/:id { name?, groupId? }                    -> 200 | 400 | 401 | 403 | 404
 *   PUT    /gantt/:id/tasks { taskIds: [] }                  -> 200 | 400 | 401 | 403 | 404 | 409 wrong season
 *   DELETE /gantt/:id                                        -> 204 | 401 | 403 | 404
 *
 * A board carries an ordered list of task ids and nothing else. Every date,
 * status and assignee in the response is read from the task at request time,
 * so a due date moved on the task page is already moved on the timeline.
 */
export async function ganttRoutes(app: FastifyInstance) {
  const service = createGanttService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  const authorizeExisting = async (
    account: AuthenticatedAccount,
    boardId: string,
    action: "read" | "update" | "delete"
  ) => {
    const board = await service.groupOf(requireTeam(account), boardId);
    if (!board) throw new NotFoundError("Pano bulunamadi");

    await authorize(app.prisma, {
      accountId: account.id,
      tool: "GANTT",
      action,
      groupId: board.groupId,
    });
    return board;
  };

  // -> 200 | 400 | 401 | 403
  app.get("/", async (req) => {
    const query = listBoardsQuerySchema.parse(req.query);
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "GANTT",
      action: "read",
      groupId: query.groupId,
    });
    return service.list(requireTeam(req.account), query);
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorizeExisting(req.account, id, "read");

    const board = await service.getById(requireTeam(req.account), id);
    if (!board) throw new NotFoundError("Pano bulunamadi");
    return board;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/", async (req, reply) => {
    const input = createBoardSchema.parse(req.body);
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "GANTT",
      action: "create",
      groupId: input.groupId,
    });

    const board = await service.create(requireTeam(req.account), input);
    reply.code(201).send(board);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = updateBoardSchema.parse(req.body);

    await authorizeExisting(req.account, id, "update");

    if (input.groupId !== undefined) {
      await authorize(app.prisma, {
        accountId: req.account.id,
        tool: "GANTT",
        action: "update",
        groupId: input.groupId,
      });
    }

    return service.update(requireTeam(req.account), id, input);
  });

  // -> 200 | 400 | 401 | 403 | 404 | 409
  app.put("/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    // Arranging a board is a GANTT permission, not a TASKS one: putting a task
    // on a timeline does not change the task, and a lead planning the season
    // should not need permission to edit other departments' work to draw it.
    await authorizeExisting(req.account, id, "update");

    return service.replaceTasks(requireTeam(req.account), id, replaceBoardTasksSchema.parse(req.body));
  });

  // -> 204 | 401 | 403 | 404
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await authorizeExisting(req.account, id, "delete");

    await service.remove(requireTeam(req.account), id);
    reply.code(204).send();
  });
}
