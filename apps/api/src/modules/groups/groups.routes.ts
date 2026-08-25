import type { FastifyInstance } from "fastify";
import {
  addGroupMemberSchema,
  createGroupSchema,
  updateGroupSchema,
} from "./groups.schema";
import { createGroupsService } from "./groups.service";
import { NotFoundError } from "../../lib/http-errors";

// Mounted at /groups by apps/api/src/app.ts.
//
// | Method | Path                            | Body                | Returns | Errors |
// | ------ | ------------------------------- | ------------------- | ------- | ------ |
// | GET    | /groups                         | -                   | 200     | -      |
// | GET    | /groups/:id                     | -                   | 200     | 404    |
// | POST   | /groups                         | { name }            | 201     | 400, 409 |
// | PATCH  | /groups/:id                     | { name? }           | 200     | 400, 404, 409 |
// | DELETE | /groups/:id                     | -                   | 204     | 404    |
// | POST   | /groups/:id/members             | { memberId }        | 201     | 400, 404, 409 |
// | DELETE | /groups/:id/members/:memberId   | -                   | 204     | 404    |
//
// 409 is a duplicate: a group name is unique, and a member can only be in a
// group once. Adding a member to a group that does not exist is a 400 — the app
// error handler maps Prisma's P2003 there, because the failure is the
// referenced id in the request, not the route. An archived member is a 404
// rather than a 400: the row exists, but every other endpoint already treats a
// soft-deleted member as gone.
export async function groupsRoutes(app: FastifyInstance) {
  const service = createGroupsService(app.prisma);

  app.get("/", async () => service.list());

  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    const group = await service.getById(id);
    if (!group) throw new NotFoundError("Group not found");
    return group;
  });

  app.post("/", async (req, reply) => {
    const input = createGroupSchema.parse(req.body);
    const group = await service.create(input);
    reply.code(201).send(group);
  });

  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = updateGroupSchema.parse(req.body);
    return service.update(id, input);
  });

  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await service.remove(id);
    reply.code(204).send();
  });

  app.post("/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = addGroupMemberSchema.parse(req.body);
    const member = await service.findActiveMember(input.memberId);
    if (!member) throw new NotFoundError("Member not found");
    const membership = await service.addMember(id, input);
    reply.code(201).send(membership);
  });

  app.delete("/:id/members/:memberId", async (req, reply) => {
    const { id, memberId } = req.params as { id: string; memberId: string };
    await service.removeMember(id, memberId);
    reply.code(204).send();
  });
}
