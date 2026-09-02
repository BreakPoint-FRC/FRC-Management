import { Prisma, type PrismaClient } from "@breakpoint/db";

import { resolveSeasonId } from "../../lib/active-season";
import { NotFoundError } from "../../lib/http-errors";
import { paginated, toPrismaPage } from "../../lib/pagination";
import type {
  CreateTransactionInput,
  ListTransactionsQuery,
  MonthlyQuery,
  SummaryQuery,
  UpdateTransactionInput,
} from "./finance.schema";

const transactionSelect = {
  id: true,
  seasonId: true,
  groupId: true,
  type: true,
  category: true,
  amount: true,
  description: true,
  transactionDate: true,
  createdAt: true,
  group: { select: { name: true } },
  createdBy: { select: { id: true, fullName: true } },
} satisfies Prisma.FinanceTransactionSelect;

type TransactionRow = Prisma.FinanceTransactionGetPayload<{ select: typeof transactionSelect }>;

// Decimal on the way out becomes a string, not a number. Prisma hands back a
// Decimal object; JSON.stringify would turn it into something lossy or into
// "[object Object]", and neither is a balance anyone should act on.
//
// toFixed(2) rather than toString(): toString drops trailing zeros, so a column
// holding 25000.00 would come back as "25000" while 4750.50 came back as
// "4750.5". Money that changes shape depending on its value is money a client
// has to normalise before it can line up a column of it.
function serialize(transaction: TransactionRow) {
  const { group, ...rest } = transaction;
  return {
    ...rest,
    groupName: group?.name ?? null,
    amount: transaction.amount.toFixed(2),
  };
}

export function createFinanceService(prisma: PrismaClient) {
  // The one place a filter is built, so the team scope cannot be present on the
  // table and missing from the chart above it.
  const buildWhere = (
    teamId: string,
    query: ListTransactionsQuery | SummaryQuery | MonthlyQuery
  ): Prisma.FinanceTransactionWhereInput => ({
    teamId,
    ...(query.seasonId ? { seasonId: query.seasonId } : {}),
    ...(query.groupId ? { groupId: query.groupId } : {}),
    ...("type" in query && query.type ? { type: query.type } : {}),
    ...("category" in query && query.category ? { category: query.category } : {}),
    ...("from" in query && (query.from || query.to)
      ? {
          transactionDate: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
  });

  return {
    list: async (teamId: string, query: ListTransactionsQuery) => {
      const where = buildWhere(teamId, query);

      const [rows, total] = await prisma.$transaction([
        prisma.financeTransaction.findMany({
          where,
          select: transactionSelect,
          orderBy: [{ transactionDate: "desc" }, { createdAt: "desc" }],
          ...toPrismaPage(query),
        }),
        prisma.financeTransaction.count({ where }),
      ]);

      return paginated(rows.map(serialize), total, query);
    },

    // findFirst rather than findUnique: the team is half the identity now, and
    // (id, teamId) is not a unique index.
    getById: async (teamId: string, id: string) => {
      const transaction = await prisma.financeTransaction.findFirst({
        where: { id, teamId },
        select: transactionSelect,
      });
      return transaction && serialize(transaction);
    },

    // Scoped to the team as well, so a route that reads the group off a stored
    // record cannot be handed another team's id and authorize against it.
    groupOf: (teamId: string, id: string) =>
      prisma.financeTransaction.findFirst({
        where: { id, teamId },
        select: { id: true, groupId: true },
      }),

    /**
     * Income, expense and the difference.
     *
     * Summed by the database over Decimal columns and subtracted with Decimal
     * arithmetic, so the numbers never pass through a float on their way to
     * being a balance.
     */
    summary: async (teamId: string, query: SummaryQuery) => {
      const where = buildWhere(teamId, query);

      const [income, expense] = await prisma.$transaction([
        prisma.financeTransaction.aggregate({
          where: { ...where, type: "INCOME" },
          _sum: { amount: true },
        }),
        prisma.financeTransaction.aggregate({
          where: { ...where, type: "EXPENSE" },
          _sum: { amount: true },
        }),
      ]);

      const totalIncome = income._sum.amount ?? new Prisma.Decimal(0);
      const totalExpense = expense._sum.amount ?? new Prisma.Decimal(0);

      return {
        income: totalIncome.toFixed(2),
        expense: totalExpense.toFixed(2),
        net: totalIncome.minus(totalExpense).toFixed(2),
      };
    },

    /**
     * The same ledger as summary(), broken into months.
     *
     * Summed here in Prisma.Decimal rather than by the database, because
     * grouping by month needs date_trunc and raw SQL cannot reuse buildWhere --
     * the filters would have to be written a second time, in another language,
     * and the chart would drift from the table underneath it the first time one
     * of them changed. Decimal arithmetic in JavaScript is exact, so the only
     * thing lost is a group-by, over a few hundred rows a season.
     *
     * Money never becomes a number on the way through: it arrives as Decimal
     * and leaves as a fixed-point string, for the reason on serialize().
     */
    monthly: async (teamId: string, query: MonthlyQuery) => {
      const rows = await prisma.financeTransaction.findMany({
        where: buildWhere(teamId, query),
        select: { type: true, amount: true, transactionDate: true },
        orderBy: { transactionDate: "asc" },
      });

      const buckets = new Map<string, { income: Prisma.Decimal; expense: Prisma.Decimal }>();

      for (const row of rows) {
        const key = monthKey(row.transactionDate);
        const bucket =
          buckets.get(key) ??
          { income: new Prisma.Decimal(0), expense: new Prisma.Decimal(0) };

        if (row.type === "INCOME") bucket.income = bucket.income.plus(row.amount);
        else bucket.expense = bucket.expense.plus(row.amount);

        buckets.set(key, bucket);
      }

      // A month with no transactions is still a month. Leaving the gap out
      // would let the chart put February next to May and draw a straight line
      // between them, which reads as "steady" rather than "nothing happened".
      const keys = [...buckets.keys()].sort();
      const filled = keys.length === 0 ? [] : monthsBetween(keys[0] as string, keys.at(-1) as string);

      return {
        items: filled.map((month) => {
          const bucket =
            buckets.get(month) ??
            { income: new Prisma.Decimal(0), expense: new Prisma.Decimal(0) };

          return {
            month,
            income: bucket.income.toFixed(2),
            expense: bucket.expense.toFixed(2),
            net: bucket.income.minus(bucket.expense).toFixed(2),
          };
        }),
      };
    },

    create: async (
      teamId: string,
      { seasonId, amount, ...rest }: CreateTransactionInput,
      actorId: string
    ) => {
      const resolvedSeasonId = await resolveSeasonId(prisma, teamId, seasonId);
      const transaction = await prisma.financeTransaction.create({
        data: {
          ...rest,
          teamId,
          amount: new Prisma.Decimal(amount),
          seasonId: resolvedSeasonId,
          createdById: actorId,
        },
        select: transactionSelect,
      });
      return serialize(transaction);
    },

    update: async (teamId: string, id: string, { amount, ...rest }: UpdateTransactionInput) => {
      const existing = await prisma.financeTransaction.count({ where: { id, teamId } });
      if (existing === 0) throw new NotFoundError("Kayit bulunamadi");

      const transaction = await prisma.financeTransaction.update({
        where: { id },
        data: { ...rest, ...(amount ? { amount: new Prisma.Decimal(amount) } : {}) },
        select: transactionSelect,
      });
      return serialize(transaction);
    },

    /**
     * Hard delete, and gated on the FINANCE delete permission, which by default
     * only the president holds.
     *
     * A wrong entry has to be removable -- a ledger that cannot be corrected
     * gets worked around in a spreadsheet, which is worse. Who deleted it is
     * not recorded today; if that becomes a question, the answer is a
     * FinanceActivity table modelled on TaskActivity, not a soft-delete flag.
     */
    remove: async (teamId: string, id: string) => {
      const existing = await prisma.financeTransaction.count({ where: { id, teamId } });
      if (existing === 0) throw new NotFoundError("Kayit bulunamadi");
      await prisma.financeTransaction.delete({ where: { id } });
    },
  };
}

/**
 * "2026-01" in the server's local time.
 *
 * Bucketing in UTC would file a transaction entered on the evening of the 31st
 * in Istanbul under the following month, so the chart and the table would
 * disagree about which month a row belongs to.
 */
function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Every month key from first to last, inclusive. */
function monthsBetween(first: string, last: string): string[] {
  const months: string[] = [];
  const cursor = new Date(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, 1);
  const end = new Date(Number(last.slice(0, 4)), Number(last.slice(5, 7)) - 1, 1);

  while (cursor <= end) {
    months.push(monthKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return months;
}
