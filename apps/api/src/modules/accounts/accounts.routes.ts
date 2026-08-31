import type { FastifyInstance } from "fastify";
import { passwordSchema } from "@breakpoint/types";
import { z } from "zod";

import { authorize } from "../../lib/authorize";
import { requireTeam } from "../../lib/tenant";
import { ConflictError, NotFoundError } from "../../lib/http-errors";
import {
  createAccountSchema,
  listAccountsQuerySchema,
  replaceRolesSchema,
  updateAccountSchema,
} from "./accounts.schema";
import { createAccountsService } from "./accounts.service";

/**
 * Mounted at /accounts. Every route requires a signed-in account and the
 * ACCOUNTS tool.
 *
 *   GET    /accounts            ?page&pageSize&groupId&search&includeArchived
 *                                                        -> 200 paginated | 400 | 401 | 403
 *   GET    /accounts/:id                                 -> 200 | 401 | 403 | 404
 *   POST   /accounts            { email, fullName, password, roles? }
 *                                                        -> 201 | 400 | 401 | 403 | 409 duplicate email
 *   PATCH  /accounts/:id        { email?, fullName?, isActive? }
 *                                                        -> 200 | 400 | 401 | 403 | 404 | 409
 *   PUT    /accounts/:id/roles  { roles: [{ roleId, groupId? }] }
 *                                                        -> 200 | 400 | 401 | 403 | 404 | 409 scope mismatch
 *   POST   /accounts/:id/password { password }           -> 204 | 400 | 401 | 403 | 404
 *   DELETE /accounts/:id                                 -> 204 | 401 | 403 | 404
 *
 * Reads are scoped by `groupId` where the caller has only a group role: a lead
 * can list their own department. Writes have no group to check against -- an
 * account is not owned by a department -- so they need a GLOBAL role, which is
 * what `groupId: undefined` asks for.
 */
export async function accountsRoutes(app: FastifyInstance) {
  const service = createAccountsService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  const resetPasswordSchema = z.object({ password: passwordSchema });

  // -> 200 | 400 | 401 | 403
  app.get("/", async (req) => {
    const query = listAccountsQuerySchema.parse(req.query);
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "ACCOUNTS",
      action: "read",
      groupId: query.groupId,
    });
    return service.list(requireTeam(req.account), query);
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "ACCOUNTS",
      action: "read",
    });

    const account = await service.getById(requireTeam(req.account), id);
    if (!account) throw new NotFoundError("Hesap bulunamadi");
    return account;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/", async (req, reply) => {
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "ACCOUNTS",
      action: "create",
    });

    const input = createAccountSchema.parse(req.body);
    const account = await service.create(requireTeam(req.account), input, req.account.id);
    reply.code(201).send(account);
  });

  // -> 200 | 400 | 401 | 403 | 404 | 409
  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "ACCOUNTS",
      action: "update",
    });

    return service.update(requireTeam(req.account), id, updateAccountSchema.parse(req.body));
  });

  // -> 200 | 400 | 401 | 403 | 404 | 409
  app.put("/:id/roles", async (req) => {
    const { id } = req.params as { id: string };
    // Handing out roles is how someone grants themselves anything else, so it
    // is gated on ROLES rather than ACCOUNTS: being able to edit a name must
    // not imply being able to make yourself an admin.
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "ROLES",
      action: "update",
    });

    return service.replaceRoles(requireTeam(req.account), id, replaceRolesSchema.parse(req.body), req.account.id);
  });

  // -> 204 | 400 | 401 | 403 | 404
  app.post("/:id/password", async (req, reply) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "ACCOUNTS",
      action: "update",
    });

    const { password } = resetPasswordSchema.parse(req.body);
    await service.resetPassword(requireTeam(req.account), id, password);
    reply.code(204).send();
  });

  // -> 204 | 401 | 403 | 404 | 409 self-archive
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "ACCOUNTS",
      action: "delete",
    });

    // Archiving yourself would revoke your own session mid-request and, if you
    // were the last admin, lock the team out of its own instance.
    if (id === req.account.id) {
      throw new ConflictError("Kendi hesabinizi arsivleyemezsiniz");
    }

    await service.archive(requireTeam(req.account), id);
    reply.code(204).send();
  });
}
