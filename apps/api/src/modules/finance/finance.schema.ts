import { z } from "zod";
import {
  positiveDecimalStringSchema,
  transactionTypeSchema,
} from "@breakpoint/types";

export const createTransactionSchema = z.object({
  type: transactionTypeSchema,
  amount: positiveDecimalStringSchema,
  counterparty: z.string().min(1),
  note: z.string().optional(),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
