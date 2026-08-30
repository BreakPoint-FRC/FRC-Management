import type { FastifyInstance } from "fastify";

import { authorize } from "../../lib/authorize";
import { NotFoundError } from "../../lib/http-errors";
import {
  createTransactionSchema,
  listTransactionsQuerySchema,
  monthlyQuerySchema,
  summaryQuerySchema,
  updateTransactionSchema,
} from "./finance.schema";
import { createFinanceService } from "./finance.service";

/**
 * Mounted at /finance.
 *
 *   GET    /finance          ?page&pageSize&seasonId&groupId&type&category&from&to
 *                                                  -> 200 paginated | 400 | 401 | 403
 *   GET    /finance/summary  ?seasonId&groupId      -> 200 { income, expense, net } | 401 | 403
 *   GET    /finance/monthly  ?seasonId&groupId&from&to
 *                                                   -> 200 { items: [{ month, income, expense, net }] } | 400 | 401 | 403
 *   GET    /finance/:id                             -> 200 | 401 | 403 | 404
 *   POST   /finance   { type, category, amount, transactionDate, groupId?, seasonId?, description? }
 *                                                   -> 201 | 400 | 401 | 403 | 409 no active season
 *   PATCH  /finance/:id                             -> 200 | 400 | 401 | 403 | 404
 *   DELETE /finance/:id                             -> 204 | 401 | 403 | 404
 *
 * Amounts are decimal strings in both directions. Sending a JSON number is a
 * 400 -- see finance.schema.
 *
 * FINANCE is off for most departments (GroupTool), so a group-scoped request
 * from Programming fails at step 5 of the authorization check even if the
 * account's role would otherwise allow it.
 */
export async function financeRoutes(app: FastifyInstance) {
  const service = createFinanceService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  const authorizeExisting = async (
    accountId: string,
    transactionId: string,
    action: "read" | "update" | "delete"
  ) => {
    const transaction = await service.groupOf(transactionId);
    if (!transaction) throw new NotFoundError("Kayit bulunamadi");

    await authorize(app.prisma, {
      accountId,
      tool: "FINANCE",
      action,
      groupId: transaction.groupId,
    });
    return transaction;
  };

  // -> 200 | 400 | 401 | 403
  app.get("/", async (req) => {
    const query = listTransactionsQuerySchema.parse(req.query);
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "FINANCE",
      action: "read",
      groupId: query.groupId,
    });
    return service.list(query);
  });

  // Declared before /:id so "summary" is not read as an id.
  // -> 200 | 400 | 401 | 403
  app.get("/summary", async (req) => {
    const query = summaryQuerySchema.parse(req.query);
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "FINANCE",
      action: "read",
      groupId: query.groupId,
    });
    return service.summary(query);
  });

  // Same reason as /summary: declared before /:id so it is not read as an id.
  // -> 200 | 400 | 401 | 403
  app.get("/monthly", async (req) => {
    const query = monthlyQuerySchema.parse(req.query);
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "FINANCE",
      action: "read",
      groupId: query.groupId,
    });
    return service.monthly(query);
  });

  // -> 200 | 401 | 403 | 404
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await authorizeExisting(req.account.id, id, "read");

    const transaction = await service.getById(id);
    if (!transaction) throw new NotFoundError("Kayit bulunamadi");
    return transaction;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/", async (req, reply) => {
    const input = createTransactionSchema.parse(req.body);
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "FINANCE",
      action: "create",
      groupId: input.groupId,
    });

    const transaction = await service.create(input, req.account.id);
    reply.code(201).send(transaction);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = updateTransactionSchema.parse(req.body);

    await authorizeExisting(req.account.id, id, "update");

    if (input.groupId !== undefined) {
      await authorize(app.prisma, {
        accountId: req.account.id,
        tool: "FINANCE",
        action: "update",
        groupId: input.groupId,
      });
    }

    return service.update(id, input);
  });

  // -> 204 | 401 | 403 | 404
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await authorizeExisting(req.account.id, id, "delete");

    await service.remove(id);
    reply.code(204).send();
  });
}
