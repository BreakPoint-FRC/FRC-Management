import { z } from "zod";
import { paginationSchema, roleScopeSchema } from "@breakpoint/types";

const roleFields = z.object({
  // Stable identifier the code refers to (SYSTEM_ADMIN, LEAD). Uppercase and
  // underscores only, so it cannot drift into something that reads like a
  // display name and then gets translated.
  key: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Rol anahtari BUYUK_HARF formatinda olmali"),
  name: z.string().min(1, "Rol adi gerekli").max(80),
  description: z.string().max(500).nullish(),
  scope: roleScopeSchema,
  // Display ordering only -- authorization never reads it. Lower sorts first,
  // so the president is 10 and a plain member is 80.
  hierarchyLevel: z.number().int().min(0).max(1000).default(100),
});

export const createRoleSchema = roleFields;

// `key` and `scope` are not updatable. The key is what code matches on, and
// changing a scope would silently invalidate every existing assignment: a
// GROUP role turned GLOBAL leaves rows carrying a groupId the model now forbids.
// Retire the role and make a new one instead.
export const updateRoleSchema = roleFields.omit({ key: true, scope: true }).partial();

export const listRolesQuerySchema = paginationSchema.extend({
  scope: roleScopeSchema.optional(),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type ListRolesQuery = z.infer<typeof listRolesQuerySchema>;
