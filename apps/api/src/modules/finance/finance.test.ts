import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@breakpoint/db";

import {
  createTransactionSchema,
  listTransactionsQuerySchema,
  monthlyQuerySchema,
} from "./finance.schema";
import { createFinanceService } from "./finance.service";

// Every service call is scoped to a team now. The id itself is arbitrary; what
// the tests pin is that it reaches the query.
const TEAM = "team-1";

describe("transaction payload validation", () => {
  it("accepts an amount as a decimal string", async () => {
    const result = createTransactionSchema.safeParse({
      type: "INCOME",
      category: "Sponsorluk",
      amount: "25000.00",
      transactionDate: "2026-08-20",
    });

    expect(result.success).toBe(true);
  });

  it("rejects an amount sent as a JSON number", async () => {
    // A JSON number is an IEEE double. Accepting one here is how a budget
    // quietly loses a kurus somewhere between the browser and the column.
    const result = createTransactionSchema.safeParse({
      type: "EXPENSE",
      category: "Parca",
      amount: 4750.5,
      transactionDate: "2026-08-24",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a zero or negative amount", async () => {
    for (const amount of ["0", "0.00", "-10.00"]) {
      const result = createTransactionSchema.safeParse({
        type: "EXPENSE",
        category: "Parca",
        amount,
        transactionDate: "2026-08-24",
      });
      expect(result.success, `amount ${amount}`).toBe(false);
    }
  });
});

describe("serialization", () => {
  it("returns a database Decimal as a string, not a number", async () => {
    const prisma = {
      financeTransaction: {
        // findFirst, not findUnique: the team is half the identity now.
        findFirst: async () => ({
          id: "t1",
          seasonId: "s1",
          groupId: null,
          type: "INCOME",
          category: "Sponsorluk",
          amount: new Prisma.Decimal("25000.00"),
          description: null,
          transactionDate: new Date("2026-08-20"),
          createdAt: new Date("2026-08-20"),
          group: null,
          createdBy: { id: "a1", fullName: "Ada Yilmaz" },
        }),
      },
    } as unknown as PrismaClient;

    const transaction = await createFinanceService(prisma).getById(TEAM, "t1");

    expect(transaction?.amount).toBe("25000.00");
    expect(typeof transaction?.amount).toBe("string");
  });
});

describe("summary", () => {
  it("subtracts with Decimal arithmetic and reports strings", async () => {
    const aggregate = vi
      .fn()
      .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal("25000.00") } })
      .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal("5950.50") } });

    const prisma = {
      financeTransaction: { aggregate },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;

    const summary = await createFinanceService(prisma).summary(TEAM, {});

    expect(summary).toEqual({ income: "25000.00", expense: "5950.50", net: "19049.50" });
  });

  it("reports zeroes rather than null for a season with no records", async () => {
    const prisma = {
      financeTransaction: { aggregate: vi.fn().mockResolvedValue({ _sum: { amount: null } }) },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;

    const summary = await createFinanceService(prisma).summary(TEAM, { seasonId: "s1" });

    expect(summary).toEqual({ income: "0.00", expense: "0.00", net: "0.00" });
  });

  it("narrows the summary with the same filters as the list", async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { amount: null } });
    const prisma = {
      financeTransaction: { aggregate },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;

    await createFinanceService(prisma).summary(TEAM, { seasonId: "s1", groupId: "g1" });

    expect(aggregate.mock.calls[0]?.[0].where).toMatchObject({
      teamId: TEAM,
      seasonId: "s1",
      groupId: "g1",
      type: "INCOME",
    });
  });
});

describe("list filters", () => {
  it("turns a from/to pair into a single date range", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      financeTransaction: { findMany, count: async () => 0 },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;

    await createFinanceService(prisma).list(
      TEAM,
      listTransactionsQuerySchema.parse({ from: "2026-01-01", to: "2026-06-30" })
    );

    expect(findMany.mock.calls[0]?.[0].where.transactionDate).toEqual({
      gte: new Date("2026-01-01"),
      lte: new Date("2026-06-30"),
    });
  });
});

describe("monthly breakdown", () => {
  const tx = (type: "INCOME" | "EXPENSE", amount: string, date: string) => ({
    type,
    amount: new Prisma.Decimal(amount),
    transactionDate: new Date(date),
  });

  const serviceOver = (rows: ReturnType<typeof tx>[]) => {
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = {
      financeTransaction: {
        findMany,
        count: async () => rows.length,
        aggregate: async ({ where }: { where: { type: string } }) => ({
          _sum: {
            amount: rows
              .filter((row) => row.type === where.type)
              .reduce((total, row) => total.plus(row.amount), new Prisma.Decimal(0)),
          },
        }),
      },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;

    return { service: createFinanceService(prisma), findMany };
  };

  it("buckets by month and keeps the kurus", async () => {
    const { service } = serviceOver([
      tx("INCOME", "4750.50", "2026-01-10"),
      tx("INCOME", "1249.50", "2026-01-20"),
      tx("EXPENSE", "1000.25", "2026-01-31"),
    ]);

    const { items } = await service.monthly(TEAM, {});

    expect(items).toEqual([
      { month: "2026-01", income: "6000.00", expense: "1000.25", net: "4999.75" },
    ]);
  });

  it("keeps trailing zeros, so a column of amounts lines up", async () => {
    // toFixed(2) rather than toString(): 25000.00 must not come back "25000"
    // while 4750.50 comes back "4750.5".
    const { service } = serviceOver([tx("INCOME", "25000.00", "2026-02-01")]);

    const { items } = await service.monthly(TEAM, {});

    expect(items[0]?.income).toBe("25000.00");
  });

  it("fills the months nobody spent anything in", async () => {
    // A gap left out would let the chart put February next to May and draw a
    // straight line between them, which reads as "steady".
    const { service } = serviceOver([
      tx("EXPENSE", "100.00", "2026-02-05"),
      tx("INCOME", "300.00", "2026-05-05"),
    ]);

    const { items } = await service.monthly(TEAM, {});

    expect(items.map((item) => item.month)).toEqual([
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
    ]);
    expect(items[1]).toEqual({
      month: "2026-03",
      income: "0.00",
      expense: "0.00",
      net: "0.00",
    });
  });

  it("returns nothing at all when the ledger is empty", async () => {
    const { service } = serviceOver([]);

    await expect(service.monthly(TEAM, {})).resolves.toEqual({ items: [] });
  });

  it("applies the same filters as the list", async () => {
    const { service, findMany } = serviceOver([]);

    await service.monthly(
      TEAM,
      monthlyQuerySchema.parse({
        groupId: "g1",
        seasonId: "s1",
        from: "2026-01-01",
        to: "2026-06-30",
      })
    );

    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      teamId: TEAM,
      seasonId: "s1",
      groupId: "g1",
      transactionDate: { gte: new Date("2026-01-01"), lte: new Date("2026-06-30") },
    });
  });

  it("agrees with the summary over the same rows", async () => {
    // The two answers are computed by different code paths -- one groups in
    // JavaScript, the other aggregates in the database -- and the chart sitting
    // above the totals must not contradict them.
    const rows = [
      tx("INCOME", "4750.50", "2026-01-10"),
      tx("EXPENSE", "1000.25", "2026-02-11"),
      tx("INCOME", "25000.00", "2026-03-12"),
      tx("EXPENSE", "9999.99", "2026-03-13"),
    ];
    const { service } = serviceOver(rows);

    const [{ items }, summary] = await Promise.all([service.monthly(TEAM, {}), service.summary(TEAM, {})]);

    const net = items.reduce(
      (total, item) => total.plus(new Prisma.Decimal(item.net)),
      new Prisma.Decimal(0)
    );

    expect(net.toFixed(2)).toBe(summary.net);
  });
});
