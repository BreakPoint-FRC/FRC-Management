import { z } from "zod";
import {
  paginationSchema,
  placementForbidsGroupScope,
  placementNeedsGroupScope,
  rolePlacementSchema,
} from "@breakpoint/types";

const roleFields = z.object({
  // Stable identifier the code refers to (TEAM_ADMIN, LEAD). Uppercase and
  // underscores only, so it cannot drift into something that reads like a
  // display name and then gets translated.
  key: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Rol anahtari BUYUK_HARF formatinda olmali"),
  name: z.string().min(1, "Rol adi gerekli").max(80),
  description: z.string().max(500).nullish(),
  placement: rolePlacementSchema,
  // The groups this role has authority over -- the roots of it. The subtree
  // under each is resolved at request time, so scoping to Teknik covers Tasarim
  // without listing it.
  groupScopeIds: z.array(z.string().min(1)).default([]),
});

/**
 * The half of the placement rule that does not need the database.
 *
 * MANAGES_GROUP and ABOVE_GROUPS are meaningless without a group to have
 * authority over; TEAM_WIDE and EXTERNAL would be describing a narrowing the
 * resolver does not honour. That the named groups exist and belong to this team
 * is checked in the service, which is the only place that can know.
 */
function checkGroupScope(
  value: { placement: z.infer<typeof rolePlacementSchema>; groupScopeIds: string[] },
  ctx: z.RefinementCtx
) {
  if (placementNeedsGroupScope(value.placement) && value.groupScopeIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["groupScopeIds"],
      message: "Bu konum icin en az bir grup secilmeli",
    });
  }
  if (placementForbidsGroupScope(value.placement) && value.groupScopeIds.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["groupScopeIds"],
      message: "Bu konum tum takimi kapsar, ayrica grup secilemez",
    });
  }
}

export const createRoleSchema = roleFields.superRefine(checkGroupScope);

// `key` is not updatable: it is what code matches on.
//
// `placement` is, unlike the old `scope` -- but only together with the scope
// list, which is why they are validated as a pair below. Changing a placement
// can still invalidate existing assignments (an IN_GROUP role turned TEAM_WIDE
// leaves rows carrying a groupId the model now forbids), so the service
// rewrites those assignments in the same transaction rather than leaving them.
export const updateRoleSchema = roleFields
  .omit({ key: true })
  .partial()
  .superRefine((value, ctx) => {
    // When the list is omitted, the service combines the requested placement
    // with the role's stored scopes. The schema cannot decide that pair without
    // the database, but it can still reject an explicitly invalid pair here.
    if (value.placement === undefined || value.groupScopeIds === undefined) return;
    checkGroupScope({ placement: value.placement, groupScopeIds: value.groupScopeIds }, ctx);
  });

export const listRolesQuerySchema = paginationSchema.extend({
  placement: rolePlacementSchema.optional(),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type ListRolesQuery = z.infer<typeof listRolesQuerySchema>;
