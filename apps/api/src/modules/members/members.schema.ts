import { z } from "zod";
import { roleSchema } from "@breakpoint/types";

export const createMemberSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: roleSchema.default("STUDENT"),
});

export const updateMemberSchema = createMemberSchema.partial();

export type CreateMemberInput = z.infer<typeof createMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
