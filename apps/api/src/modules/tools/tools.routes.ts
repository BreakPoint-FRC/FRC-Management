import type { FastifyInstance } from "fastify";

import { authorize } from "../../lib/authorize";
import { NotFoundError } from "../../lib/http-errors";
import { createToolSchema, updateToolSchema } from "./tools.schema";
import { createToolsService } from "./tools.service";

/**
 * Mounted at /tools.
 *
 *   GET    /tools           -> 200 | 401 | 403
 *   GET    /tools/:id       -> 200 | 401 | 403 | 404
 *   POST   /tools    { key, name, description?, isActive? }
 *                           -> 201 | 400 | 401 | 403 | 409 duplicate key
 *   PATCH  /tools/:id { name?, description?, isActive? }
 *                           -> 200 | 400 | 401 | 403 | 404
 *   DELETE /tools/:id       -> 204 | 401 | 403 | 404   (deactivates)
 *
 * A tool is the unit permissions are granted against, so editing this list is
 * editing the vocabulary the whole authorization layer speaks. In practice only
 * SYSTEM_ADMIN holds TOOLS write permission.
 */
export async function toolsRoutes(app: FastifyInstance) {
  const service = createToolsService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // -> 200 | 401 | 403
  app.get("/", async (req) => {
    await authorize(app.prisma, { accountId: req.account.id, tool: "TOOLS", action: "read" });
    return service.list();
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "TOOLS", action: "read" });

    const tool = await service.getById(id);
    if (!tool) throw new NotFoundError("Modul bulunamadi");
    return tool;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/", async (req, reply) => {
    await authorize(app.prisma, { accountId: req.account.id, tool: "TOOLS", action: "create" });

    const tool = await service.create(createToolSchema.parse(req.body));
    reply.code(201).send(tool);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "TOOLS", action: "update" });

    return service.update(id, updateToolSchema.parse(req.body));
  });

  // -> 204 | 401 | 403 | 404
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, { accountId: req.account.id, tool: "TOOLS", action: "delete" });

    await service.deactivate(id);
    reply.code(204).send();
  });
}
