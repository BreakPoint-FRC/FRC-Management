import { z } from "zod";

// Where a role applies. GLOBAL roles are team-wide and are the only ones
// allowed to skip the group-membership check; GROUP roles mean nothing without
// the group they were assigned in.
export const roleScopeSchema = z.enum(["GLOBAL", "GROUP"]);

export const roleSchema = z.object({
  id: z.string(),
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  scope: roleScopeSchema,
  // Display ordering only. Who inherits whose permissions is the RoleHierarchy
  // graph and only that -- see docs/authorization.md.
  hierarchyLevel: z.number().int(),
  isSystemRole: z.boolean(),
});

// One role an account holds. An account carries a list of these, so "yazilim
// lead ve elektronik lead" is two entries rather than something the model
// cannot say.
//
// groupId is required for a GROUP-scoped role and must be absent for a GLOBAL
// one. That rule needs to know the role's scope, so it cannot live in this
// schema -- it is checked in accounts.service against the stored Role.
export const accountRoleInputSchema = z.object({
  roleId: z.string().min(1),
  groupId: z.string().nullish(),
});

// A resolved role as it comes back from the API, with the names needed to
// render it.
export const accountRoleSchema = z.object({
  roleId: z.string(),
  roleKey: z.string(),
  roleName: z.string(),
  scope: roleScopeSchema,
  hierarchyLevel: z.number().int(),
  groupId: z.string().nullable(),
  groupName: z.string().nullable(),
});

// One edge of the hierarchy. An edge means "parent is above child", and
// permission resolution reads it as a parent inheriting the union of its
// descendants' permissions.
export const roleHierarchyEdgeSchema = z
  .object({
    parentRoleId: z.string().min(1),
    childRoleId: z.string().min(1),
  })
  .refine((edge) => edge.parentRoleId !== edge.childRoleId, {
    message: "Bir rol kendisine bagli olamaz",
    path: ["childRoleId"],
  });

/**
 * The one place a role and its group are collapsed into a label:
 * "Yazilim Lead", "Baskan", "Business Uye".
 *
 * The names come from the database rather than a map in this file, because a
 * team can add a department or rename a role without a deploy.
 */
export function formatAccountRole(roleName: string, groupName?: string | null): string {
  return groupName ? `${groupName} ${roleName}` : roleName;
}

/** Highest-precedence first, then alphabetically by group name. */
export function sortAccountRoles<T extends { hierarchyLevel: number; groupName?: string | null }>(
  roles: readonly T[]
): T[] {
  return [...roles].sort((a, b) => {
    const byLevel = a.hierarchyLevel - b.hierarchyLevel;
    if (byLevel !== 0) return byLevel;
    return (a.groupName ?? "").localeCompare(b.groupName ?? "");
  });
}

/**
 * The role to show when there is only room for one -- listings, sorting.
 *
 * Derived, never stored. A "primary role" column would be a second copy of a
 * fact the role list already holds, and the two would eventually disagree.
 */
export function primaryAccountRole<
  T extends { hierarchyLevel: number; groupName?: string | null },
>(roles: readonly T[]): T | undefined {
  return sortAccountRoles(roles)[0];
}

/** "Baskan Yardimcisi, Mechanical Lead" */
export function formatAccountRoles(
  roles: readonly { roleName: string; groupName?: string | null; hierarchyLevel: number }[]
): string {
  return sortAccountRoles(roles)
    .map((entry) => formatAccountRole(entry.roleName, entry.groupName))
    .join(", ");
}

export type Role = z.infer<typeof roleSchema>;
export type RoleScope = z.infer<typeof roleScopeSchema>;
export type AccountRole = z.infer<typeof accountRoleSchema>;
export type AccountRoleInput = z.infer<typeof accountRoleInputSchema>;
export type RoleHierarchyEdge = z.infer<typeof roleHierarchyEdgeSchema>;
