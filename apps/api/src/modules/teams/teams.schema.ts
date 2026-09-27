import { z } from "zod";
import { createTeamSchema, emailSchema, paginationSchema, updateTeamSchema } from "@breakpoint/types";

export { createTeamSchema, updateTeamSchema };

export const listTeamsQuerySchema = paginationSchema.extend({
  includeInactive: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true")
    .default(false),
});

// A second (or third) administrator for an existing team. Same shape as the
// first one, which is created with the team itself.
export const createTeamAdminSchema = z.object({
  fullName: z.string().min(1, "Ad soyad gerekli").max(120),
  email: emailSchema,
});

export type ListTeamsQuery = z.infer<typeof listTeamsQuerySchema>;
export type CreateTeamAdminInput = z.infer<typeof createTeamAdminSchema>;
