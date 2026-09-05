import type { FastifyInstance } from "fastify";
import { rolePermissionMatrixSchema } from "@breakpoint/types";

import { authorize } from "../../lib/authorize";
import { NotFoundError } from "../../lib/http-errors";
import { requireTeam } from "../../lib/tenant";
import { createRoleSchema, listRolesQuerySchema, updateRoleSchema } from "./roles.schema";
import { createRolesService } from "./roles.service";

/**
 * Mounted at /roles. Everything here is a team-wide act -- a role is not owned
 * by a department -- so no route passes a groupId and all of them need a
 * TEAM_WIDE role that grants ROLES (or PERMISSIONS for the matrix).
 *
 * Every route is scoped to the team of the caller. Reads also return the
 * platform roles, so a team admin can see that SYSTEM_ADMIN exists and that
 * they are not it; writes filter on the team id alone, so those cannot be
 * touched.
 *
 *   GET    /roles                      ?page&pageSize&placement -> 200 paginated | 400 | 401 | 403
 *   GET    /roles/graph                                         -> 200 | 401 | 403
 *   GET    /roles/:id                                           -> 200 | 401 | 403 | 404
 *   POST   /roles     { key, name, description?, placement, groupScopeIds? }
 *                                                               -> 201 | 400 | 401 | 403 | 409 duplicate key
 *   PATCH  /roles/:id { name?, description?, placement?, groupScopeIds? }
 *                                                               -> 200 | 400 | 401 | 403 | 404
 *   DELETE /roles/:id                                           -> 204 | 401 | 403 | 404 | 409 system or assigned
 *   PUT    /roles/:id/permissions { permissions: [{ tool, canRead, ... }] }
 *                                                    -> 204 | 400 | 401 | 403 | 404 | 409 platform-only tool
 *   POST   /roles/:id/children/:childId                         -> 204 | 401 | 403 | 404 | 409 cycle
 *   DELETE /roles/:id/children/:childId                         -> 204 | 401 | 403 | 404
 *
 * An edge means "this role is above that one", and permission resolution reads
 * it as the parent inheriting the union of the permissions of its descendants.
 * The relation is transitive and nothing stores that: /roles/graph returns the
 * closure so the UI can show that a role bound to a role bound to a third is
 * bound to the third as well.
 */
export async function rolesRoutes(app: FastifyInstance) {
  const service = createRolesService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // -> 200 | 400 | 401 | 403
  app.get("/", async (req) => {
    const query = listRolesQuerySchema.parse(req.query);
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "read" });
    return service.list(requireTeam(req.account), query);
  });

  // The hierarchy with its transitive closure, for drawing the role tree.
  // Registered before /:id, which would otherwise match "graph" as an id.
  // -> 200 | 401 | 403
  app.get("/graph", async (req) => {
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "read" });
    return service.graph(requireTeam(req.account));
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "read" });

    const role = await service.getById(requireTeam(req.account), id);
    if (!role) throw new NotFoundError("Rol bulunamadi");
    return role;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/", async (req, reply) => {
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "create" });

    const role = await service.create(requireTeam(req.account), createRoleSchema.parse(req.body));
    reply.code(201).send(role);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "update" });

    return service.update(requireTeam(req.account), id, updateRoleSchema.parse(req.body));
  });

  // -> 204 | 401 | 403 | 404 | 409
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "delete" });

    await service.remove(requireTeam(req.account), id);
    reply.code(204).send();
  });

  // -> 204 | 400 | 401 | 403 | 404
  app.put("/:id/permissions", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Gated on PERMISSIONS, not ROLES: renaming a role and deciding what it can
    // do are different amounts of power, and the matrix is the one that matters.
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "PERMISSIONS",
      action: "update",
    });

    await service.replacePermissions(
      requireTeam(req.account),
      id,
      rolePermissionMatrixSchema.parse(req.body)
    );
    reply.code(204).send();
  });

  // -> 204 | 401 | 403 | 404 | 409 cycle or self-reference
  app.post("/:id/children/:childId", async (req, reply) => {
    const { id, childId } = req.params as { id: string; childId: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "update" });

    await service.linkRoles(requireTeam(req.account), id, childId);
    reply.code(204).send();
  });

  // -> 204 | 401 | 403 | 404
  app.delete("/:id/children/:childId", async (req, reply) => {
    const { id, childId } = req.params as { id: string; childId: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "update" });

    await service.unlinkRoles(requireTeam(req.account), id, childId);
    reply.code(204).send();
  });
}
