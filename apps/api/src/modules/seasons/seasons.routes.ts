import type { FastifyInstance } from "fastify";

import { authorize } from "../../lib/authorize";
import { NotFoundError } from "../../lib/http-errors";
import {
  createSeasonSchema,
  listSeasonsQuerySchema,
  updateSeasonSchema,
} from "./seasons.schema";
import { createSeasonsService } from "./seasons.service";

/**
 * Mounted at /seasons.
 *
 *   GET    /seasons          ?page&pageSize   -> 200 paginated | 400 | 401 | 403
 *   GET    /seasons/current                   -> 200 | 401 | 403 | 404 none active
 *   GET    /seasons/:id                       -> 200 | 401 | 403 | 404
 *   POST   /seasons  { name, startDate, endDate, isActive? }
 *                                             -> 201 | 400 | 401 | 403 | 409 duplicate name
 *   PATCH  /seasons/:id { name?, startDate?, endDate?, isActive? }
 *                                             -> 200 | 400 | 401 | 403 | 404
 *   POST   /seasons/:id/activate              -> 200 | 401 | 403 | 404
 *   DELETE /seasons/:id                       -> 204 | 401 | 403 | 404 | 409 not empty
 *
 * A season is team-wide, so none of these take a group.
 */
export async function seasonsRoutes(app: FastifyInstance) {
  const service = createSeasonsService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // -> 200 | 400 | 401 | 403
  app.get("/", async (req) => {
    const query = listSeasonsQuerySchema.parse(req.query);
    await authorize(app.prisma, { accountId: req.account.id, tool: "SEASONS", action: "read" });
    return service.list(query);
  });

  // Declared before /:id so "current" is not read as an id.
  // -> 200 | 401 | 403 | 404
  app.get("/current", async (req) => {
    await authorize(app.prisma, { accountId: req.account.id, tool: "SEASONS", action: "read" });

    const season = await service.current();
    if (!season) throw new NotFoundError("Aktif sezon yok");
    return season;
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "SEASONS", action: "read" });

    const season = await service.getById(id);
    if (!season) throw new NotFoundError("Sezon bulunamadi");
    return season;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/", async (req, reply) => {
    await authorize(app.prisma, { accountId: req.account.id, tool: "SEASONS", action: "create" });

    const season = await service.create(createSeasonSchema.parse(req.body));
    reply.code(201).send(season);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "SEASONS", action: "update" });

    return service.update(id, updateSeasonSchema.parse(req.body));
  });

  // -> 200 | 401 | 403 | 404
  app.post("/:id/activate", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "SEASONS", action: "update" });

    return service.activate(id);
  });

  // -> 204 | 401 | 403 | 404 | 409
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "SEASONS", action: "delete" });

    await service.remove(id);
    reply.code(204).send();
  });
}
