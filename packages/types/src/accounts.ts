import { z } from "zod";

import { accountRoleSchema } from "./roles";

// Minimum that is worth enforcing rather than theatre. Length does more for a
// password than a character-class rule, which mostly teaches people to end
// everything with "1!".
export const passwordSchema = z.string().min(10, "Sifre en az 10 karakter olmali").max(200);

export const emailSchema = z.string().email("Gecerli bir e-posta adresi girin");

export const accountSchema = z.object({
  id: z.string(),
  email: emailSchema,
  fullName: z.string().min(1),
  isActive: z.boolean(),
  archivedAt: z.coerce.date().nullable(),
  roles: z.array(accountRoleSchema),
});

// isActive and archivedAt answer different questions and both are kept:
// isActive   -- may they sign in right now (suspension)
// archivedAt -- have they left the team (roster history)
// The API exposes both; DELETE /accounts/:id sets archivedAt and clears
// isActive, because someone who has left should not also still be able to log
// in.
export type Account = z.infer<typeof accountSchema>;
