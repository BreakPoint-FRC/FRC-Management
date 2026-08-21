import { Prisma, type PrismaClient } from "@breakpoint/db";
import type { CreateTransactionInput } from "./finance.schema";

function serializeTransaction<T extends { amount: Prisma.Decimal }>(transaction: T) {
  return { ...transaction, amount: transaction.amount.toString() };
}

export function createFinanceService(prisma: PrismaClient) {
  return {
    list: async () => {
      const transactions = await prisma.transaction.findMany({
        orderBy: { createdAt: "desc" },
      });
      return transactions.map(serializeTransaction);
    },

    create: async (input: CreateTransactionInput) => {
      const transaction = await prisma.transaction.create({
        data: { ...input, amount: new Prisma.Decimal(input.amount) },
      });
      return serializeTransaction(transaction);
    },

    balance: async () => {
      const [income, expense] = await Promise.all([
        prisma.transaction.aggregate({
          where: { type: "INCOME" },
          _sum: { amount: true },
        }),
        prisma.transaction.aggregate({
          where: { type: "EXPENSE" },
          _sum: { amount: true },
        }),
      ]);
      const totalIncome = income._sum.amount ?? new Prisma.Decimal(0);
      const totalExpense = expense._sum.amount ?? new Prisma.Decimal(0);
      return {
        totalIncome: totalIncome.toString(),
        totalExpense: totalExpense.toString(),
        balance: totalIncome.minus(totalExpense).toString(),
      };
    },
  };
}
