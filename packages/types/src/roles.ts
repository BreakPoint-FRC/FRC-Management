import { z } from "zod";

// Where a role sits relative to the groups it has authority over.
//
// This replaces the old GLOBAL/GROUP pair, which could only say "this one
// group" or "every group". There was no way to write "the Technical Director
// runs Mechanical, Software and Electrical but has no business in Media" --
// that is what the three group-facing values plus a scope list add.
export const rolePlacementSchema = z.enum([
  "IN_GROUP",
  "MANAGES_GROUP",
  "ABOVE_GROUPS",
  "TEAM_WIDE",
  "EXTERNAL",
]);

export type RolePlacement = z.infer<typeof rolePlacementSchema>;

export const ROLE_PLACEMENT_LABELS: Record<RolePlacement, string> = {
  IN_GROUP: "Grup icinde",
  MANAGES_GROUP: "Grubu yonetir",
  ABOVE_GROUPS: "Gruplarin ustunde",
  TEAM_WIDE: "Takim geneli",
  EXTERNAL: "Takim disi",
};

export const ROLE_PLACEMENT_DESCRIPTIONS: Record<RolePlacement, string> = {
  IN_GROUP: "Grubun uyesi olarak calisir. Yetkisi atandigi gruptadir.",
  MANAGES_GROUP: "Secili gruplari ve altlarindaki tum alt gruplari yonetir.",
  ABOVE_GROUPS: "Secili gruplarin ustundedir; gunluk isini yurutmeden yetkilidir.",
  TEAM_WIDE: "Takimin tamami. Her grup ve gruba bagli olmayan kayitlar dahil.",
  EXTERNAL: "Takima bagli ama grup yapisinin disinda: mentor, sponsor, mezun.",
};

/**
 * Which placements take their coverage from RoleGroupScope.
 *
 * MANAGES_GROUP and ABOVE_GROUPS are meaningless without at least one group --
 * a role that manages nothing is not a role. The API rejects an empty list for
 * these, and the web form requires one before it will submit.
 */
export function placementNeedsGroupScope(placement: RolePlacement): boolean {
  return placement === "MANAGES_GROUP" || placement === "ABOVE_GROUPS";
}

/**
 * Which placements must have no scope list at all.
 *
 * TEAM_WIDE already covers every group, so naming some would be a narrowing the
 * resolver does not honour. EXTERNAL covers none by definition.
 */
export function placementForbidsGroupScope(placement: RolePlacement): boolean {
  return placement === "TEAM_WIDE" || placement === "EXTERNAL";
}

/**
 * Whether AccountRole.groupId applies.
 *
 * Only IN_GROUP is scoped by the assignment. The others carry their coverage on
 * the role itself, so an assignment naming a group would describe something the
 * resolver ignores -- which is why it is rejected rather than dropped silently.
 */
export function placementUsesAssignmentGroup(placement: RolePlacement): boolean {
  return placement === "IN_GROUP";
}

export const roleSchema = z.object({
  id: z.string(),
  // null for platform roles (SYSTEM_ADMIN), which exist above every team.
  teamId: z.string().nullable(),
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  placement: rolePlacementSchema,
  // The roots of the authority of this role, not the closure: scoping to Teknik
  // covers Tasarim under it, resolved by walking the group tree.
  groupScopeIds: z.array(z.string()),
  isSystemRole: z.boolean(),
});

// One role an account holds. An account carries a list of these, so "yazilim
// lead ve elektronik lead" is two entries rather than something the model
// cannot say.
//
// groupId is required for an IN_GROUP role and must be absent for every other
// placement. That rule needs to know the placement, so it cannot live in this
// schema -- it is checked in accounts.service against the stored Role.
export const accountRoleInputSchema = z.object({
  roleId: z.string().min(1),
  groupId: z.string().nullish(),
});

// A resolved role as it comes back from the API, with the names needed to
// render it.
//
// `depth` is how far the role sits below the top of the RoleHierarchy graph,
// computed on read by the API and never stored. It exists so a list can be
// sorted without shipping the whole graph to sort it. That is not the old
// hierarchyLevel column returning: a derived value cannot disagree with the
// graph it came from, which is exactly what a stored rank could.
export const accountRoleSchema = z.object({
  roleId: z.string(),
  roleKey: z.string(),
  roleName: z.string(),
  placement: rolePlacementSchema,
  depth: z.number().int(),
  groupId: z.string().nullable(),
  groupName: z.string().nullable(),
});

// One edge of the hierarchy. An edge means "parent is above child", and
// permission resolution reads it as a parent inheriting the union of the
// permissions of its descendants.
//
// The relation is transitive and nothing stores that: if 1 is above 2 and 2 is
// above 3 then 1 is above 3, because the resolver walks to arbitrary depth
// rather than stopping at the first hop.
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
export function sortAccountRoles<T extends { depth: number; groupName?: string | null }>(
  roles: readonly T[]
): T[] {
  return [...roles].sort((a, b) => {
    const byDepth = a.depth - b.depth;
    if (byDepth !== 0) return byDepth;
    return (a.groupName ?? "").localeCompare(b.groupName ?? "");
  });
}

/**
 * The role to show when there is only room for one -- listings, sorting.
 *
 * Derived, never stored. A "primary role" column would be a second copy of a
 * fact the role list already holds, and the two would eventually disagree.
 */
export function primaryAccountRole<T extends { depth: number; groupName?: string | null }>(
  roles: readonly T[]
): T | undefined {
  return sortAccountRoles(roles)[0];
}

/** "Baskan Yardimcisi, Mechanical Lead" */
export function formatAccountRoles(
  roles: readonly { roleName: string; groupName?: string | null; depth: number }[]
): string {
  return sortAccountRoles(roles)
    .map((entry) => formatAccountRole(entry.roleName, entry.groupName))
    .join(", ");
}

/**
 * How far each role sits below the top of the hierarchy.
 *
 * A role nothing points at is 0; a child is one deeper than its deepest parent.
 * This is the replacement for the hierarchyLevel column, and the difference
 * that matters is that it is computed from the edges every time rather than
 * maintained beside them.
 *
 * A cycle has no answer, so when a pass resolves nothing the roles still left
 * are parked at the back rather than looping forever. The write path rejects
 * cycles (roles.service.linkRoles); this only declines to hang if one gets in.
 */
export function roleDepths(
  roleIds: readonly string[],
  edges: readonly { parentRoleId: string; childRoleId: string }[]
): Map<string, number> {
  const known = new Set(roleIds);
  const parentsOf = new Map<string, string[]>();
  for (const edge of edges) {
    if (!known.has(edge.parentRoleId) || !known.has(edge.childRoleId)) continue;
    const parents = parentsOf.get(edge.childRoleId);
    if (parents) parents.push(edge.parentRoleId);
    else parentsOf.set(edge.childRoleId, [edge.parentRoleId]);
  }

  const depths = new Map<string, number>();
  for (const id of roleIds) if (!parentsOf.has(id)) depths.set(id, 0);
  let pending = roleIds.filter((id) => parentsOf.has(id));

  while (pending.length > 0) {
    const unresolved: string[] = [];
    for (const id of pending) {
      const parents = parentsOf.get(id) as string[];
      if (parents.every((parent) => depths.has(parent))) {
        depths.set(id, Math.max(...parents.map((p) => depths.get(p) as number)) + 1);
      } else {
        unresolved.push(id);
      }
    }
    if (unresolved.length === pending.length) {
      for (const id of unresolved) depths.set(id, roleIds.length);
      break;
    }
    pending = unresolved;
  }

  return depths;
}

/**
 * Roles in display order: shallowest first, then by name.
 *
 * The order comes from the graph, so adding an edge reorders the list and there
 * is no number anyone has to remember to renumber.
 */
export function sortRolesByHierarchy<T extends { id: string; name: string }>(
  roles: readonly T[],
  edges: readonly { parentRoleId: string; childRoleId: string }[]
): T[] {
  const depths = roleDepths(
    roles.map((role) => role.id),
    edges
  );
  return [...roles].sort((a, b) => {
    const byDepth = (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0);
    if (byDepth !== 0) return byDepth;
    return a.name.localeCompare(b.name);
  });
}

export type Role = z.infer<typeof roleSchema>;
export type AccountRole = z.infer<typeof accountRoleSchema>;
export type AccountRoleInput = z.infer<typeof accountRoleInputSchema>;
export type RoleHierarchyEdge = z.infer<typeof roleHierarchyEdgeSchema>;
