import type { FastifyInstance } from "fastify";
import { createMemberSchema, updateMemberSchema } from "./members.schema";
import { createMembersService } from "./members.service";
import { NotFoundError } from "../../lib/http-errors";

export async function membersRoutes(app: FastifyInstance) {
  const service = createMembersService(app.prisma);

  app.get("/", async () => service.list());

  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    const member = await service.getById(id);
    if (!member) throw new NotFoundError("Member not found");
    return member;
  });

  app.post("/", async (req, reply) => {
    const input = createMemberSchema.parse(req.body);
    const member = await service.create(input);
    reply.code(201).send(member);
  });

  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = updateMemberSchema.parse(req.body);
    return service.update(id, input);
  });

  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await service.remove(id);
    reply.code(204).send();
  });
}
