"use client";

import {
  flattenGroupTree,
  placementForbidsGroupScope,
  placementNeedsGroupScope,
  ROLE_PLACEMENT_DESCRIPTIONS,
  ROLE_PLACEMENT_LABELS,
  rolePlacementSchema,
  type RolePlacement,
} from "@breakpoint/types";

import { AsyncSection } from "@/components/ui";
import { SelectField, TextAreaField, TextField } from "@/components/ui/form";
import type { ApiState } from "@/hooks/use-api";
import type { GroupTreeRow } from "@/lib/api-types";
import { issueFor } from "@/lib/issues";
import type { ApiError } from "@/lib/api-client";

export interface RoleDraft {
  key: string;
  name: string;
  description: string;
  placement: RolePlacement;
  groupScopeIds: string[];
}

export const EMPTY_ROLE_DRAFT: RoleDraft = {
  key: "",
  name: "",
  description: "",
  placement: "IN_GROUP",
  groupScopeIds: [],
};

/**
 * The body of a role form, shared by the roles screen and the setup wizard.
 *
 * Controlled: the caller owns the draft and decides what saving means. The two
 * callers differ in that and in nothing else, so a second copy of these fields
 * would only be a second place to update when a placement is added.
 */
export function RoleFields({
  draft,
  onChange,
  groups,
  editing,
  error,
}: {
  draft: RoleDraft;
  onChange: (next: RoleDraft) => void;
  /** The team tree, for the scope picker. */
  groups: ApiState<GroupTreeRow[]>;
  /** True when an existing role is being edited: its key is then frozen. */
  editing: boolean;
  error: ApiError | null;
}) {
  return (
    <>
      <TextField
        label="Anahtar"
        value={draft.key}
        required={!editing}
        disabled={editing}
        placeholder="ARSIV_SORUMLUSU"
        hint={
          editing ? "Degistirilemez: kodun eslestirdigi sey budur." : "BUYUK_HARF ve alt cizgi."
        }
        onChange={(key) => onChange({ ...draft, key })}
        error={issueFor(error, "key")}
      />
      <TextField
        label="Ad"
        value={draft.name}
        required
        onChange={(name) => onChange({ ...draft, name })}
        error={issueFor(error, "name")}
      />
      <TextAreaField
        label="Aciklama"
        rows={2}
        value={draft.description}
        onChange={(description) => onChange({ ...draft, description })}
        error={issueFor(error, "description")}
      />
      <SelectField
        label="Konum"
        value={draft.placement}
        hint={ROLE_PLACEMENT_DESCRIPTIONS[draft.placement]}
        options={rolePlacementSchema.options.map((placement) => ({
          value: placement,
          label: ROLE_PLACEMENT_LABELS[placement],
        }))}
        onChange={(placement) => onChange({ ...draft, placement: placement as RolePlacement })}
        error={issueFor(error, "placement")}
      />

      {/* TEAM_WIDE already covers every group and EXTERNAL covers none, so for
          both the list would describe something the resolver ignores. */}
      {placementForbidsGroupScope(draft.placement) ? null : (
        <div className="field">
          <label>
            Kapsanan gruplar{placementNeedsGroupScope(draft.placement) ? " *" : ""}
          </label>
          <p className="small muted" style={{ margin: "0 0 6px" }}>
            Secilen grubun altindaki tum alt gruplar da kapsanir. Teknik secmek Mekanik ve
            Tasarim icin de yetki verir.
          </p>
          <AsyncSection state={groups}>
            {(tree) => (
              <div className="stack-sm">
                {flattenGroupTree(tree).map(({ group, depth }) => (
                  <label
                    key={group.id}
                    className="row small"
                    style={{ paddingLeft: depth * 16 }}
                  >
                    <input
                      type="checkbox"
                      checked={draft.groupScopeIds.includes(group.id)}
                      onChange={(event) =>
                        onChange({
                          ...draft,
                          groupScopeIds: event.target.checked
                            ? [...draft.groupScopeIds, group.id]
                            : draft.groupScopeIds.filter((id) => id !== group.id),
                        })
                      }
                    />
                    {group.name}
                  </label>
                ))}
              </div>
            )}
          </AsyncSection>
          {issueFor(error, "groupScopeIds") ? (
            <span className="field-error">{issueFor(error, "groupScopeIds")}</span>
          ) : null}
        </div>
      )}
    </>
  );
}

/**
 * The draft as POST /roles and PATCH /roles/:id want it.
 *
 * The scope list is dropped for the placements that forbid one, so an edit that
 * moves a role to TEAM_WIDE does not send a list the server would reject.
 */
export function roleBody(draft: RoleDraft, editing: boolean) {
  const groupScopeIds = placementForbidsGroupScope(draft.placement) ? [] : draft.groupScopeIds;
  const shared = {
    name: draft.name,
    description: draft.description.trim() === "" ? null : draft.description,
    placement: draft.placement,
    groupScopeIds,
  };
  // key is omitted on edit: updateRoleSchema refuses it, because it is what the
  // code matches on.
  return editing ? shared : { key: draft.key, ...shared };
}
