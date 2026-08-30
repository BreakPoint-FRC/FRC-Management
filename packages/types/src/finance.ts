import { z } from "zod";

export const transactionTypeSchema = z.enum(["INCOME", "EXPENSE"]);

// Money crosses the API as a string, never a number. The column is
// DECIMAL(12,2); a JSON number is an IEEE double, so serialising through one
// would undo the exactness the column exists for.
export const decimalStringSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, "Must be a decimal string");

export const positiveDecimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "Must be a positive decimal string")
  .refine((value) => !/^0(?:\.0+)?$/.test(value), "Must be greater than zero");

export const financeTransactionSchema = z.object({
  id: z.string(),
  seasonId: z.string(),
  groupId: z.string().nullable(),
  type: transactionTypeSchema,
  category: z.string().min(1),
  amount: positiveDecimalStringSchema,
  description: z.string().nullable(),
  transactionDate: z.coerce.date(),
});

// Totals are decimal strings for the same reason the amounts are. `net` is
// income minus expense and is the only one that can be negative.
export const financeSummarySchema = z.object({
  income: decimalStringSchema,
  expense: decimalStringSchema,
  net: decimalStringSchema,
});

export const transactionTypeLabels: Record<TransactionType, string> = {
  INCOME: "Gelir",
  EXPENSE: "Gider",
};

export type FinanceTransaction = z.infer<typeof financeTransactionSchema>;
export type FinanceSummary = z.infer<typeof financeSummarySchema>;
export type TransactionType = z.infer<typeof transactionTypeSchema>;
