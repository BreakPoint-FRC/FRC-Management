"use client";

import { PLATFORM_ONLY_TOOL_KEYS, TOOL_KEYS, type ToolKey } from "@breakpoint/types";

/**
 * The four flags a RolePermission row carries, and the letters the UI shows
 * them as. Turkish initials: Okuma, Ekleme, Guncelleme, Silme.
 */
export const PERMISSION_ACTIONS = [
  { key: "canRead", short: "O", label: "Okuma" },
  { key: "canCreate", short: "E", label: "Ekleme" },
  { key: "canUpdate", short: "G", label: "Guncelleme" },
  { key: "canDelete", short: "S", label: "Silme" },
] as const;

export type PermissionFlags = Record<(typeof PERMISSION_ACTIONS)[number]["key"], boolean>;
/** tool key -> its four flags. A tool left out is denied. */
export type PermissionMatrixValue = Record<string, PermissionFlags>;

export const NO_FLAGS: PermissionFlags = {
  canRead: false,
  canCreate: false,
  canUpdate: false,
  canDelete: false,
};

const NOTHING_LOCKED: ReadonlySet<ToolKey> = new Set<ToolKey>();
const PLATFORM_ONLY: ReadonlySet<ToolKey> = new Set<ToolKey>(PLATFORM_ONLY_TOOL_KEYS);

/**
 * The tools this account may not be granted, given the team it belongs to.
 *
 * A platform account (teamId null) is locked out of nothing. For everyone else
 * the platform-only tools are locked: the API refuses to store the grant
 * (roles.service.replacePermissions) and would answer 403 on the routes anyway,
 * so a tickable box here would only be a promise the server breaks.
 */
export function lockedToolsFor(teamId: string | null | undefined): ReadonlySet<ToolKey> {
  // Only an explicit null -- a platform account -- unlocks them. While the
  // profile is still loading teamId is undefined, and "locked" is the safe
  // reading of not knowing yet.
  return teamId === null ? NOTHING_LOCKED : PLATFORM_ONLY;
}

/** The stored matrix of a role, in the shape this editor takes. */
export function matrixFromPermissions(
  permissions: ReadonlyArray<{ tool: string } & PermissionFlags>
): PermissionMatrixValue {
  return Object.fromEntries(
    TOOL_KEYS.map((tool) => {
      const stored = permissions.find((entry) => entry.tool === tool);
      return [
        tool,
        stored
          ? {
              canRead: stored.canRead,
              canCreate: stored.canCreate,
              canUpdate: stored.canUpdate,
              canDelete: stored.canDelete,
            }
          : { ...NO_FLAGS },
      ];
    })
  );
}

/**
 * The whole set, as PUT /roles/:id/permissions wants it.
 *
 * A locked tool is sent as four falses rather than left out: the endpoint
 * replaces the matrix whole, so an omitted tool and an empty one mean the same
 * thing to it, and sending the row keeps the payload the same shape for every
 * role. Forcing them empty rather than passing them through is what makes a
 * role that somehow holds a locked grant saveable -- the save clears it instead
 * of failing on it forever.
 */
export function permissionsPayload(
  value: PermissionMatrixValue,
  lockedTools: ReadonlySet<ToolKey> = NOTHING_LOCKED
) {
  return TOOL_KEYS.map((tool) => ({
    tool,
    ...(lockedTools.has(tool) ? NO_FLAGS : value[tool] ?? NO_FLAGS),
  }));
}

/**
 * The role x tool grid, as a controlled component.
 *
 * Shared by the roles screen and the setup wizard rather than written twice.
 * The two differ in what surrounds it -- a panel that closes on save, or a step
 * that stays open -- and not at all in the grid itself, so a second copy would
 * only be a second thing to update when the tool list changes.
 *
 * Only *direct* grants are edited here. What a role inherits from the roles
 * below it is resolved from the hierarchy at request time and never written, so
 * showing inherited flags as ticked would invite someone to "fix" them by hand.
 */
export function PermissionMatrix({
  value,
  onChange,
  disabled = false,
  lockedTools = NOTHING_LOCKED,
}: {
  value: PermissionMatrixValue;
  onChange: (next: PermissionMatrixValue) => void;
  disabled?: boolean;
  /**
   * Tools this account cannot grant at all -- drawn, but not tickable. See
   * lockedToolsFor: the API refuses these, and a box that always fails to save
   * is worse than one that is visibly not on offer.
   */
  lockedTools?: ReadonlySet<ToolKey>;
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Modul</th>
            {PERMISSION_ACTIONS.map((action) => (
              <th key={action.key} className="numeric" title={action.label}>
                {action.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TOOL_KEYS.map((tool) => {
            const locked = lockedTools.has(tool);
            return (
              <tr key={tool}>
                <td>
                  {tool}
                  {locked ? (
                    <span className="small muted"> — platform rolu</span>
                  ) : null}
                </td>
                {PERMISSION_ACTIONS.map((action) => (
                  <td key={action.key} className="numeric">
                    <input
                      type="checkbox"
                      disabled={disabled || locked}
                      title={locked ? "Bu modul yalnizca platform rolune verilebilir" : undefined}
                      checked={locked ? false : value[tool]?.[action.key] ?? false}
                      onChange={(event) =>
                        onChange({
                          ...value,
                          [tool]: {
                            ...(value[tool] ?? NO_FLAGS),
                            [action.key]: event.target.checked,
                          },
                        })
                      }
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
