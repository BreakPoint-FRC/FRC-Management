import type { FastifyInstance } from "fastify";
import { rolePermissionMatrixSchema } from "@breakpoint/types";

import { authorize } from "../../lib/authorize";
import { NotFoundError } from "../../lib/http-errors";
import { createRoleSchema, listRolesQuerySchema, updateRoleSchema } from "./roles.schema";
import { createRolesService } from "./roles.service";

/**
 * Mounted at /roles. Everything here is a team-wide act -- a role is not owned
 * by a department -- so no route passes a groupId and all of them need a GLOBAL
 * role that grants ROLES (or PERMISSIONS for the matrix).
 *
 *   GET    /roles                          ?page&pageSize&scope -> 200 paginated | 400 | 401 | 403
 *   GET    /roles/:id                                           -> 200 | 401 | 403 | 404
 *   POST   /roles     { key, name, description?, scope, hierarchyLevel? }
 *                                                               -> 201 | 400 | 401 | 403 | 409 duplicate key
 *   PATCH  /roles/:id { name?, description?, hierarchyLevel? }   -> 200 | 400 | 401 | 403 | 404
 *   DELETE /roles/:id                                           -> 204 | 401 | 403 | 404 | 409 system or assigned
 *   PUT    /roles/:id/permissions { permissions: [{ tool, canRead, ... }] }
 *                                                               -> 204 | 400 | 401 | 403 | 404
 *   POST   /roles/:id/children/:childId                         -> 204 | 401 | 403 | 404 | 409 cycle
 *   DELETE /roles/:id/children/:childId                         -> 204 | 401 | 403 | 404
 *
 * An edge means "this role is above that one", and permission resolution reads
 * it as the parent inheriting the union of its descendants' permissions.
 */
export async function rolesRoutes(app: FastifyInstance) {
  const service = createRolesService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // -> 200 | 400 | 401 | 403
  app.get("/", async (req) => {
    const query = listRolesQuerySchema.parse(req.query);
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "read" });
    return service.list(query);
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "read" });

    const role = await service.getById(id);
    if (!role) throw new NotFoundError("Rol bulunamadi");
    return role;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/", async (req, reply) => {
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "create" });

    const role = await service.create(createRoleSchema.parse(req.body));
    reply.code(201).send(role);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "update" });

    return service.update(id, updateRoleSchema.parse(req.body));
  });

  // -> 204 | 401 | 403 | 404 | 409
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "delete" });

    await service.remove(id);
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

    await service.replacePermissions(id, rolePermissionMatrixSchema.parse(req.body));
    reply.code(204).send();
  });

  // -> 204 | 401 | 403 | 404 | 409 cycle or self-reference
  app.post("/:id/children/:childId", async (req, reply) => {
    const { id, childId } = req.params as { id: string; childId: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "update" });

    await service.linkRoles(id, childId);
    reply.code(204).send();
  });

  // -> 204 | 401 | 403 | 404
  app.delete("/:id/children/:childId", async (req, reply) => {
    const { id, childId } = req.params as { id: string; childId: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "ROLES", action: "update" });

    await service.unlinkRoles(id, childId);
    reply.code(204).send();
  });
}
