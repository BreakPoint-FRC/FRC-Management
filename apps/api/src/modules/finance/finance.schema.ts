import { z } from "zod";
import {
  paginationSchema,
  positiveDecimalStringSchema,
  transactionTypeSchema,
} from "@breakpoint/types";

const transactionFields = z.object({
  seasonId: z.string().min(1).optional(),
  // Null means the transaction is not any one department's -- a registration
  // fee, a bus. The spec calls this out as nullable explicitly.
  groupId: z.string().min(1).nullish(),
  type: transactionTypeSchema,
  category: z.string().min(1, "Kategori gerekli").max(80),
  // A decimal string, never a number. JSON numbers are IEEE doubles, so parsing
  // "4750.50" as one and writing it back is how a budget quietly loses a kurus.
  amount: positiveDecimalStringSchema,
  description: z.string().max(2000).nullish(),
  transactionDate: z.coerce.date(),
});

export const createTransactionSchema = transactionFields;
export const updateTransactionSchema = transactionFields.omit({ seasonId: true }).partial();

export const listTransactionsQuerySchema = paginationSchema.extend({
  seasonId: z.string().optional(),
  groupId: z.string().optional(),
  type: transactionTypeSchema.optional(),
  category: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const summaryQuerySchema = z.object({
  seasonId: z.string().optional(),
  groupId: z.string().optional(),
});

// The same scope as the summary, plus the date range the list already accepts,
// so the chart above the table and the table below it are looking at the same
// slice of the ledger.
export const monthlyQuerySchema = summaryQuerySchema.extend({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
export type MonthlyQuery = z.infer<typeof monthlyQuerySchema>;
