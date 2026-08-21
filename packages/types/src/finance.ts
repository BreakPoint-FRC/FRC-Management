import { z } from "zod";

export const transactionTypeSchema = z.enum(["INCOME", "EXPENSE"]);

export const decimalStringSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, "Must be a decimal string");

export const positiveDecimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "Must be a positive decimal string")
  .refine((value) => !/^0(?:\.0+)?$/.test(value), "Must be greater than zero");

export const transactionSchema = z.object({
  id: z.string(),
  type: transactionTypeSchema,
  amount: positiveDecimalStringSchema,
  counterparty: z.string().min(1),
  note: z.string().nullable(),
});

export type Transaction = z.infer<typeof transactionSchema>;
export type TransactionType = z.infer<typeof transactionTypeSchema>;
