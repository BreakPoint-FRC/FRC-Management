"use client";

import {
  flattenGroupTree,
  placementUsesAssignmentGroup,
  ROLE_PLACEMENT_LABELS,
} from "@breakpoint/types";

import type { ApiError } from "@/lib/api-client";
import type { GroupTreeRow, RoleRow } from "@/lib/api-types";
import { issueFor } from "@/lib/issues";

/** One row of the editor. "" for groupId means no group, which the API sends as null. */
export interface RoleAssignmentDraft {
  roleId: string;
  groupId: string;
}

/** The list as PUT /accounts/:id/roles and POST /accounts want it. */
export function roleAssignmentPayload(drafts: readonly RoleAssignmentDraft[]) {
  return drafts.map((entry) => ({
    roleId: entry.roleId,
    groupId: entry.groupId === "" ? null : entry.groupId,
  }));
}

/**
 * The role list of an account, as a controlled component.
 *
 * Shared by the accounts screen and the setup wizard. The group select mirrors
 * the server rule rather than leaving it to be discovered: only an IN_GROUP role
 * is scoped by the assignment, so for every other placement the field is
 * disabled and cleared. Sending one anyway is a guaranteed 409, and a form that
 * lets someone build a request the server will always refuse is a form that
 * teaches the wrong model.
 */
export function RoleAssignmentRows({
  value,
  onChange,
  roles,
  groups,
  error,
}: {
  value: readonly RoleAssignmentDraft[];
  onChange: (next: RoleAssignmentDraft[]) => void;
  roles: readonly RoleRow[];
  groups: readonly GroupTreeRow[];
  error: ApiError | null;
}) {
  const setAt = (index: number, next: RoleAssignmentDraft) =>
    onChange(value.map((item, at) => (at === index ? next : item)));

  return (
    <div className="stack-sm">
      {value.map((entry, index) => {
        const role = roles.find((item) => item.id === entry.roleId);
        const needsGroup = role !== undefined && placementUsesAssignmentGroup(role.placement);

        return (
          <div key={index} className="row">
            <select
              value={entry.roleId}
              onChange={(event) => {
                const roleId = event.target.value;
                const next = roles.find((item) => item.id === roleId);
                setAt(index, {
                  roleId,
                  // Switching to a placement that carries its own coverage
                  // drops the group, rather than leaving a value the server
                  // would reject on save.
                  groupId:
                    next && placementUsesAssignmentGroup(next.placement) ? entry.groupId : "",
                });
              }}
            >
              <option value="">Rol sec...</option>
              {roles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({ROLE_PLACEMENT_LABELS[item.placement].toLowerCase()})
                </option>
              ))}
            </select>

            <select
              value={entry.groupId}
              disabled={!needsGroup}
              onChange={(event) => setAt(index, { ...entry, groupId: event.target.value })}
            >
              <option value="">{needsGroup ? "Grup sec..." : "Grup yok"}</option>
              {flattenGroupTree(groups).map(({ group, depth }) => (
                <option key={group.id} value={group.id}>
                  {"\u00a0\u00a0".repeat(depth)}
                  {group.name}
                </option>
              ))}
            </select>

            <button
              className="btn btn-sm"
              type="button"
              onClick={() => onChange(value.filter((_, at) => at !== index))}
            >
              Cikar
            </button>

            {issueFor(error, "roles", index) ? (
              <span className="field-error">{issueFor(error, "roles", index)}</span>
            ) : null}
          </div>
        );
      })}

      <button
        className="btn btn-sm"
        type="button"
        onClick={() => onChange([...value, { roleId: "", groupId: "" }])}
      >
        + Rol ekle
      </button>
    </div>
  );
}
