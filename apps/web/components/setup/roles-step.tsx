"use client";

import { useState } from "react";
import { ROLE_PLACEMENT_LABELS, type Paginated } from "@breakpoint/types";

import {
  EMPTY_ROLE_DRAFT,
  roleBody,
  RoleFields,
  type RoleDraft,
} from "@/components/roles/role-fields";
import { AsyncSection, Badge, ConfirmButton, ErrorBox, RowActions } from "@/components/ui";
import { FormPanel } from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { GroupTreeRow, RoleGraphRow, RoleRow } from "@/lib/api-types";

/**
 * The second step: who the team has, and who is above whom.
 *
 * Offers a starting set rather than demanding one be invented -- building a
 * role tree and a permission matrix from nothing is a lot to ask on a first day,
 * and most FRC teams are shaped roughly the same way. Every row of it can be
 * renamed, rewired or deleted, which is the whole reason roles are rows.
 *
 * The form fields are the same component the roles screen uses, not a copy.
 */
export function RolesStep() {
  const roles = useApi<Paginated<RoleRow>>("/roles?pageSize=100");
  const groups = useApi<GroupTreeRow[]>("/groups/tree");
  const graph = useApi<RoleGraphRow>("/roles/graph");
  const mutation = useMutation();

  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<RoleDraft>(EMPTY_ROLE_DRAFT);
  /** parentRoleId -> the child about to be attached to it. */
  const [childPick, setChildPick] = useState<Record<string, string>>({});

  function reloadAll() {
    roles.reload();
    graph.reload();
  }

  function openCreate() {
    setEditing(null);
    setDraft(EMPTY_ROLE_DRAFT);
    setFormOpen(true);
    mutation.reset();
  }

  function openEdit(role: RoleRow) {
    setEditing(role);
    setDraft({
      key: role.key,
      name: role.name,
      description: role.description ?? "",
      placement: role.placement,
      groupScopeIds: role.groupScopeIds,
    });
    setFormOpen(true);
    mutation.reset();
  }

  async function submit() {
    const body = roleBody(draft, editing !== null);
    const ok = await mutation.run(() =>
      editing ? apiClient.patch(`/roles/${editing.id}`, body) : apiClient.post("/roles", body)
    );
    if (!ok) return;
    setFormOpen(false);
    setEditing(null);
    reloadAll();
  }

  async function applyTemplate() {
    if (await mutation.run(() => apiClient.post("/setup/template"))) reloadAll();
  }

  async function remove(id: string) {
    if (await mutation.run(() => apiClient.delete(`/roles/${id}`))) reloadAll();
  }

  async function link(parentId: string) {
    const childId = childPick[parentId];
    if (!childId) return;
    // A cycle would hang every authorized request, so the server walks the
    // graph before writing and answers 409.
    if (await mutation.run(() => apiClient.post(`/roles/${parentId}/children/${childId}`))) {
      setChildPick((current) => ({ ...current, [parentId]: "" }));
      reloadAll();
    }
  }

  async function unlink(parentId: string, childId: string) {
    if (await mutation.run(() => apiClient.delete(`/roles/${parentId}/children/${childId}`))) {
      reloadAll();
    }
  }

  return (
    <div className="stack-sm">
      {!formOpen && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={roles}>
        {(data) => {
          // TEAM_ADMIN comes with the team and is not something the team chose,
          // so "has this team defined any roles" means the rest.
          const own = data.items.filter((role) => !role.isSystemRole);
          const byId = new Map(own.map((role) => [role.id, role]));

          return (
            <div className="stack-sm">
              {own.length === 0 ? (
                <div className="card stack-sm">
                  <p className="small muted" style={{ margin: 0 }}>
                    Henuz rol tanimlanmamis. FRC takimlarinin cogunda ise yarayan bir baslangic
                    seti uygulayabilir, sonra istediginiz gibi degistirebilirsiniz.
                  </p>
                  <div className="row">
                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      disabled={mutation.saving}
                      onClick={() => void applyTemplate()}
                    >
                      Varsayilan rol setini uygula
                    </button>
                    <button className="btn btn-sm" type="button" onClick={openCreate}>
                      Sifirdan basla
                    </button>
                  </div>
                </div>
              ) : null}

              {own.length > 0 ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Rol</th>
                        <th>Konum</th>
                        <th>Kapsam</th>
                        <th>Ustunde oldugu roller</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {own.map((role) => (
                        <tr key={role.id}>
                          <td>{role.name}</td>
                          <td>
                            <Badge tone={role.placement === "TEAM_WIDE" ? "warn" : "off"}>
                              {ROLE_PLACEMENT_LABELS[role.placement]}
                            </Badge>
                          </td>
                          <td className="small">
                            {role.groupScopes.length > 0
                              ? role.groupScopes.map((group) => group.name).join(", ")
                              : "—"}
                          </td>
                          <td className="small">
                            <div className="stack-sm">
                              {role.children.length === 0 ? (
                                <span className="muted">Yok</span>
                              ) : (
                                role.children.map((child) => (
                                  <span key={child.id} className="row">
                                    {child.name}
                                    <button
                                      className="btn btn-sm"
                                      type="button"
                                      onClick={() => void unlink(role.id, child.id)}
                                    >
                                      Kaldir
                                    </button>
                                  </span>
                                ))
                              )}
                              <span className="row">
                                <select
                                  value={childPick[role.id] ?? ""}
                                  onChange={(event) =>
                                    setChildPick((current) => ({
                                      ...current,
                                      [role.id]: event.target.value,
                                    }))
                                  }
                                >
                                  <option value="">Alt rol ekle...</option>
                                  {own
                                    .filter(
                                      (other) =>
                                        other.id !== role.id &&
                                        !role.children.some((child) => child.id === other.id)
                                    )
                                    .map((other) => (
                                      <option key={other.id} value={other.id}>
                                        {other.name}
                                      </option>
                                    ))}
                                </select>
                                <button
                                  className="btn btn-sm"
                                  type="button"
                                  disabled={!childPick[role.id]}
                                  onClick={() => void link(role.id)}
                                >
                                  Bagla
                                </button>
                              </span>
                            </div>
                          </td>
                          <td>
                            <RowActions>
                              <button
                                className="btn btn-sm"
                                type="button"
                                onClick={() => openEdit(role)}
                              >
                                Duzenle
                              </button>
                              {/* Same weight as deleting a group, and the
                                  hierarchy edges below it go with it. */}
                              <ConfirmButton
                                question={`${role.name} rolu silinsin mi?`}
                                onConfirm={() => void remove(role.id)}
                              >
                                Sil
                              </ConfirmButton>
                            </RowActions>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {/* The transitive part, shown because it is the thing nobody
                  expects: binding A above B and B above C also puts A above C,
                  and nothing stores that edge. Drawing only the direct ones
                  would make the tree look smaller than it is. */}
              <AsyncSection state={graph}>
                {(shape) => {
                  const rows = shape.closure.filter(
                    (entry) => entry.below.length > 0 && byId.has(entry.roleId)
                  );
                  if (rows.length === 0) return <></>;

                  const nameOf = (id: string) =>
                    shape.roles.find((role) => role.id === id)?.name ?? id;

                  return (
                    <div className="card">
                      <p className="card-title" style={{ marginTop: 0 }}>
                        Bagliliklar
                      </p>
                      <p className="small muted" style={{ marginTop: 0 }}>
                        Bir rol, altindaki her rolun yetkilerini devralir. Baglilik zincir
                        halinde okunur: 1 rolu 2ye, 2 rolu 3e bagliysa 1 rolu 3e de baglidir.
                        Asagidaki liste dolayli baglari da gosterir.
                      </p>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {rows.map((entry) => (
                          <li key={entry.roleId} className="small">
                            <strong>{nameOf(entry.roleId)}</strong> →{" "}
                            {entry.below.map(nameOf).join(", ")}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                }}
              </AsyncSection>

              {formOpen ? (
                <FormPanel
                  title={editing ? `${editing.key} — duzenle` : "Yeni rol"}
                  error={mutation.error}
                  saving={mutation.saving}
                  onSubmit={submit}
                  onCancel={() => {
                    setFormOpen(false);
                    setEditing(null);
                    mutation.reset();
                  }}
                >
                  <RoleFields
                    draft={draft}
                    onChange={setDraft}
                    groups={groups}
                    editing={editing !== null}
                    error={mutation.error}
                  />
                </FormPanel>
              ) : (
                <div className="row">
                  <button className="btn btn-sm" type="button" onClick={openCreate}>
                    + Yeni rol
                  </button>
                </div>
              )}
            </div>
          );
        }}
      </AsyncSection>
    </div>
  );
}
