import type { FastifyInstance } from "fastify";

import { authorize } from "../../lib/authorize";
import { NotFoundError } from "../../lib/http-errors";
import { requirePlatform } from "../../lib/tenant";
import {
  createTeamAdminSchema,
  createTeamSchema,
  listTeamsQuerySchema,
  updateTeamSchema,
} from "./teams.schema";
import { createTeamsService } from "./teams.service";

/**
 * Mounted at /teams. The platform surface: opening a team, archiving one, and
 * creating the administrator who will run it.
 *
 *   GET    /teams              ?page&pageSize&includeInactive -> 200 paginated | 400 | 401 | 403
 *   GET    /teams/:id                                         -> 200 | 401 | 403 | 404
 *   POST   /teams              { name, adminFullName, adminEmail }
 *                                                             -> 201 | 400 | 401 | 403 | 409 email taken
 *   PATCH  /teams/:id          { name }                        -> 200 | 400 | 401 | 403 | 404
 *   POST   /teams/:id/admins   { fullName, email }             -> 201 | 400 | 401 | 403 | 404 | 409
 *   DELETE /teams/:id                                          -> 204 | 401 | 403 | 404 | 409 already archived
 *
 * Every route is gated twice, and the two answer different questions.
 *
 * requirePlatform asks whether the caller belongs to no team. authorize asks
 * whether they hold TEAMS. The first is the one that matters here: TEAMS is
 * only ever held by the platform SYSTEM_ADMIN role by *default* -- the
 * TEAM_ADMIN matrix is seeded with every tool except this one -- and a default
 * is not a rule. A team admin edits their own roles, so they could write a
 * TEAM_WIDE role granting TEAMS and hold it, and authorize would say yes:
 * its bypass reads the placement, which is not a tenancy. requirePlatform reads
 * the account instead, so no row anywhere can produce that answer.
 *
 * There is still no isSystemAdmin flag: "who may open a team" remains a row in
 * RolePermission plus the tenancy of the account asking (docs/authorization.md).
 *
 * No route passes a groupId. A team is not inside a department, and the caller
 * is typically inside no team at all.
 *
 * POST /teams and POST /teams/:id/admins return a generated password in the
 * response body. It is the only time it exists anywhere: nothing stores it and
 * no later request can retrieve it, so the caller has to hand it over there and
 * then. The account cannot do anything but change it until it does.
 */
export async function teamsRoutes(app: FastifyInstance) {
  const service = createTeamsService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // -> 200 | 400 | 401 | 403
  app.get("/", async (req) => {
    const query = listTeamsQuerySchema.parse(req.query);
    requirePlatform(req.account);
    await authorize(app.prisma, { accountId: req.account.id, tool: "TEAMS", action: "read" });
    return service.list(query);
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    requirePlatform(req.account);
    await authorize(app.prisma, { accountId: req.account.id, tool: "TEAMS", action: "read" });

    const team = await service.getById(id);
    if (!team) throw new NotFoundError("Takim bulunamadi");
    return team;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/", async (req, reply) => {
    requirePlatform(req.account);
    await authorize(app.prisma, { accountId: req.account.id, tool: "TEAMS", action: "create" });

    const created = await service.create(createTeamSchema.parse(req.body), req.account.id);
    reply.code(201).send(created);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    requirePlatform(req.account);
    await authorize(app.prisma, { accountId: req.account.id, tool: "TEAMS", action: "update" });

    return service.update(id, updateTeamSchema.parse(req.body));
  });

  // -> 201 | 400 | 401 | 403 | 404 | 409
  app.post("/:id/admins", async (req, reply) => {
    const { id } = req.params as { id: string };
    requirePlatform(req.account);
    await authorize(app.prisma, { accountId: req.account.id, tool: "TEAMS", action: "create" });

    const created = await service.addAdmin(
      id,
      createTeamAdminSchema.parse(req.body),
      req.account.id
    );
    reply.code(201).send(created);
  });

  // -> 204 | 401 | 403 | 404 | 409
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    requirePlatform(req.account);
    await authorize(app.prisma, { accountId: req.account.id, tool: "TEAMS", action: "delete" });

    await service.archive(id);
    reply.code(204).send();
  });
}
