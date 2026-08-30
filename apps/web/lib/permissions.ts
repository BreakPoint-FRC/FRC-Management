import type { PermissionAction, PermissionSet, ToolKey } from "@breakpoint/types";

/**
 * The permission map GET /auth/me returns.
 *
 * `global` holds what the team-wide roles grant. `byGroup` holds the same thing
 * per department the account belongs to, already merged with `global` by the
 * API -- so a group entry is never *less* than the global one.
 */
export interface PermissionMap {
  global: Record<string, PermissionSet>;
  byGroup: Record<string, Record<string, PermissionSet>>;
}

const FLAG: Record<PermissionAction, keyof PermissionSet> = {
  read: "canRead",
  create: "canCreate",
  update: "canUpdate",
  delete: "canDelete",
};

/**
 * Whether the UI should offer an action.
 *
 * **This is cosmetic.** It decides whether a button is drawn, nothing more. The
 * request behind every button is authorized again on the server by
 * apps/api/src/lib/authorize.ts, and a client that lies to itself about this
 * map gets a 403. Never use it to decide whether something is safe -- only
 * whether it is worth showing.
 *
 * `groupId` mirrors the API: pass the department the record belongs to, or
 * leave it out for a team-wide action. A record with no group falls back to the
 * global set, which is the same thing step 3 of the server check does.
 */
export function can(
  permissions: PermissionMap | null | undefined,
  tool: ToolKey,
  action: PermissionAction,
  groupId?: string | null
): boolean {
  if (!permissions) return false;

  const set = groupId
    ? (permissions.byGroup[groupId]?.[tool] ?? permissions.global[tool])
    : permissions.global[tool];

  return set?.[FLAG[action]] ?? false;
}

/**
 * Whether an action is possible in *any* department the account is in.
 *
 * Used for navigation: a lead has no team-wide read on tasks, but hiding the
 * Tasks link from them would be wrong -- they can read plenty, just not
 * everything. A link is worth showing if it leads anywhere at all.
 */
export function canAnywhere(
  permissions: PermissionMap | null | undefined,
  tool: ToolKey,
  action: PermissionAction = "read"
): boolean {
  if (!permissions) return false;
  if (can(permissions, tool, action)) return true;

  return Object.keys(permissions.byGroup).some((groupId) =>
    can(permissions, tool, action, groupId)
  );
}
