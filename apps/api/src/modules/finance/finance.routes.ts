import type { FastifyInstance } from "fastify";
import { createTransactionSchema } from "./finance.schema";
import { createFinanceService } from "./finance.service";

export async function financeRoutes(app: FastifyInstance) {
  const service = createFinanceService(app.prisma);

  app.get("/", async () => service.list());

  app.get("/balance", async () => service.balance());

  app.post("/", async (req, reply) => {
    const input = createTransactionSchema.parse(req.body);
    const transaction = await service.create(input);
    reply.code(201).send(transaction);
  });
}
