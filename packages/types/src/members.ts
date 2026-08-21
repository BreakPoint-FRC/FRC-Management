import { z } from "zod";

export const roleSchema = z.enum(["ADMIN", "MENTOR", "STUDENT"]);

export const memberSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  email: z.string().email(),
  role: roleSchema,
});

export type Member = z.infer<typeof memberSchema>;
export type Role = z.infer<typeof roleSchema>;
