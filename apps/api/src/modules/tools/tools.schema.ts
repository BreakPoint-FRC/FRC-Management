import { z } from "zod";
import { toolKeySchema } from "@breakpoint/types";

// `key` is a closed enum, not free text: authorize() is called with these
// literals throughout the API, so a tool row whose key is not one of them could
// never be reached. Adding a module means adding the key to packages/types
// first.
export const createToolSchema = z.object({
  key: toolKeySchema,
  name: z.string().min(1, "Modul adi gerekli").max(80),
  description: z.string().max(500).nullish(),
  isActive: z.boolean().default(true),
});

export const updateToolSchema = createToolSchema.omit({ key: true }).partial();

export type CreateToolInput = z.infer<typeof createToolSchema>;
export type UpdateToolInput = z.infer<typeof updateToolSchema>;
