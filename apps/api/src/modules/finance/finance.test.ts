import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@breakpoint/db";
import { createTransactionSchema } from "./finance.schema";
import { createFinanceService } from "./finance.service";

describe("finance.schema", () => {
  it("accepts a sponsorship income", () => {
    const result = createTransactionSchema.safeParse({
      type: "INCOME",
      amount: "500.25",
      counterparty: "Acme Robotics",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative amount", () => {
    const result = createTransactionSchema.safeParse({
      type: "EXPENSE",
      amount: "-10",
      counterparty: "Hardware Store",
    });
    expect(result.success).toBe(false);
  });

  it("serializes database decimal amounts as strings", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "t1", amount: new Prisma.Decimal("12.50") },
    ]);
    const prisma = { transaction: { findMany } } as unknown as PrismaClient;

    const result = await createFinanceService(prisma).list();

    expect(result).toEqual([{ id: "t1", amount: "12.5" }]);
  });

  it("calculates the balance without converting decimals to numbers", async () => {
    const aggregate = vi
      .fn()
      .mockResolvedValueOnce({
        _sum: { amount: new Prisma.Decimal("9007199254740993.01") },
      })
      .mockResolvedValueOnce({
        _sum: { amount: new Prisma.Decimal("0.01") },
      });
    const prisma = { transaction: { aggregate } } as unknown as PrismaClient;

    const result = await createFinanceService(prisma).balance();

    expect(result).toEqual({
      totalIncome: "9007199254740993.01",
      totalExpense: "0.01",
      balance: "9007199254740993",
    });
  });
});
