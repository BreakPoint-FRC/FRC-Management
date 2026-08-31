"use client";

import { TOOL_KEYS } from "@breakpoint/types";

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

/** The whole set, as PUT /roles/:id/permissions wants it. */
export function permissionsPayload(value: PermissionMatrixValue) {
  return TOOL_KEYS.map((tool) => ({ tool, ...(value[tool] ?? NO_FLAGS) }));
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
}: {
  value: PermissionMatrixValue;
  onChange: (next: PermissionMatrixValue) => void;
  disabled?: boolean;
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
          {TOOL_KEYS.map((tool) => (
            <tr key={tool}>
              <td>{tool}</td>
              {PERMISSION_ACTIONS.map((action) => (
                <td key={action.key} className="numeric">
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={value[tool]?.[action.key] ?? false}
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
