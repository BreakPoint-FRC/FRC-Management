import type { FastifyInstance } from "fastify";

import { authorize } from "../../lib/authorize";
import { NotFoundError } from "../../lib/http-errors";
import {
  createGroupSchema,
  listGroupsQuerySchema,
  replaceGroupToolsSchema,
  replaceMembersSchema,
  updateGroupSchema,
} from "./groups.schema";
import { createGroupsService } from "./groups.service";

/**
 * Mounted at /groups.
 *
 *   GET    /groups             ?page&pageSize&includeInactive -> 200 paginated | 400 | 401 | 403
 *   GET    /groups/:id                                        -> 200 | 401 | 403 | 404
 *   GET    /groups/:id/members                                -> 200 | 401 | 403 | 404
 *   POST   /groups             { name, description?, isActive? }
 *                                                             -> 201 | 400 | 401 | 403 | 409 duplicate name
 *   PATCH  /groups/:id         { name?, description?, isActive? }
 *                                                             -> 200 | 400 | 401 | 403 | 404 | 409
 *   PUT    /groups/:id/tools   { tools: [{ tool, isEnabled }] }
 *                                                             -> 204 | 400 | 401 | 403 | 404
 *   PUT    /groups/:id/members { accountIds: [] }             -> 204 | 400 | 401 | 403 | 404 | 409 role holder
 *   DELETE /groups/:id                                        -> 204 | 401 | 403 | 404
 *
 * Reads pass the group itself as the scope, so a lead can read their own
 * department without a team-wide role. Writes do not: creating or renaming a
 * department is a team-wide act, and a lead editing their own group could
 * otherwise turn tools on for themselves.
 */
export async function groupsRoutes(app: FastifyInstance) {
  const service = createGroupsService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // -> 200 | 400 | 401 | 403
  app.get("/", async (req) => {
    const query = listGroupsQuerySchema.parse(req.query);
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "GROUPS",
      action: "read",
    });
    return service.list(query);
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "GROUPS",
      action: "read",
      groupId: id,
    });

    const group = await service.getById(id);
    if (!group) throw new NotFoundError("Grup bulunamadi");
    return group;
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id/members", async (req) => {
    const { id } = req.params as { id: string };
    // The roster of a department is read through ACCOUNTS, not GROUPS: it is
    // people, and a lead who may see their team's names should not need
    // permission to edit departments.
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "ACCOUNTS",
      action: "read",
      groupId: id,
    });
    return service.members(id);
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/", async (req, reply) => {
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "GROUPS",
      action: "create",
    });

    const group = await service.create(createGroupSchema.parse(req.body));
    reply.code(201).send(group);
  });

  // -> 200 | 400 | 401 | 403 | 404 | 409
  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "GROUPS",
      action: "update",
    });

    return service.update(id, updateGroupSchema.parse(req.body));
  });

  // -> 204 | 400 | 401 | 403 | 404
  app.put("/:id/tools", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Which modules a department may use decides what its own roles can reach,
    // so it is gated on TOOLS rather than GROUPS. A lead must not be able to
    // switch Finance on for their own department.
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "TOOLS",
      action: "update",
    });

    await service.replaceTools(id, replaceGroupToolsSchema.parse(req.body));
    reply.code(204).send();
  });

  // -> 204 | 400 | 401 | 403 | 404 | 409
  app.put("/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "GROUPS",
      action: "update",
      groupId: id,
    });

    await service.replaceMembers(id, replaceMembersSchema.parse(req.body));
    reply.code(204).send();
  });

  // -> 204 | 401 | 403 | 404
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "GROUPS",
      action: "delete",
    });

    await service.deactivate(id);
    reply.code(204).send();
  });
}
