import { z } from "zod";
import {
  accountRoleInputSchema,
  emailSchema,
  paginationSchema,
  passwordSchema,
} from "@breakpoint/types";

// The role list is validated in two places on purpose. Everything that can be
// judged from the payload alone is here; the rules that need to know a role's
// scope -- a GROUP role requires a group, a GLOBAL one forbids it -- need the
// stored Role and so live in accounts.service.
const roleListSchema = z.array(accountRoleInputSchema).superRefine((roles, ctx) => {
  const seen = new Set<string>();
  roles.forEach((entry, index) => {
    const key = `${entry.roleId}:${entry.groupId ?? ""}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: "Bu rol zaten listede var",
      });
    }
    seen.add(key);
  });
});

const accountFields = z.object({
  email: emailSchema,
  fullName: z.string().min(1, "Ad soyad gerekli").max(120),
  isActive: z.boolean().default(true),
});

export const createAccountSchema = accountFields.extend({
  password: passwordSchema,
  // Optional: an account can exist before anyone has decided what it does.
  roles: roleListSchema.default([]),
});

// Password is not here. Changing it is POST /auth/password with the current
// one, or an explicit admin reset -- never a field that rides along with a
// name change.
export const updateAccountSchema = accountFields.partial();

// Roles arrive as a whole set and replace the stored one. There is no add-one
// or remove-one endpoint, because every rule above is about the set: whether an
// entry is a duplicate depends on the others, and accepting one role in
// isolation would describe an intermediate state the client cannot see.
export const replaceRolesSchema = z.object({ roles: roleListSchema });

export const listAccountsQuerySchema = paginationSchema.extend({
  groupId: z.string().optional(),
  search: z.string().trim().min(1).max(120).optional(),
  // Archived accounts are hidden by default: the roster is the live team.
  // History is still reachable by asking for it.
  includeArchived: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true")
    .default(false),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type ReplaceRolesInput = z.infer<typeof replaceRolesSchema>;
export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;
