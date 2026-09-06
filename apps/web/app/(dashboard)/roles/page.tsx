"use client";

import { useState } from "react";
import { ROLE_PLACEMENT_LABELS, TOOL_KEYS, type Paginated } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import {
  AsyncSection,
  Badge,
  ConfirmButton,
  ErrorBox,
  PageHeader,
  RowActions,
} from "@/components/ui";
import { FormPanel } from "@/components/ui/form";
import {
  matrixFromPermissions,
  PERMISSION_ACTIONS,
  lockedToolsFor,
  permissionsPayload,
  PermissionMatrix,
  type PermissionMatrixValue,
} from "@/components/roles/permission-matrix";
import {
  EMPTY_ROLE_DRAFT,
  roleBody,
  RoleFields,
  type RoleDraft,
} from "@/components/roles/role-fields";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { GroupTreeRow, RoleGraphRow, RoleRow } from "@/lib/api-types";
import { emptyToNull } from "@/lib/form-helpers";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";

type Panel =
  | { kind: "closed" }
  | { kind: "form"; role: RoleRow | null }
  | { kind: "permissions"; role: RoleRow };

/**
 * Renders the hierarchy downward from the roots.
 *
 * An edge means "parent is above child", and a parent inherits the union of its
 * descendants' permissions -- so indentation here reads as "everything below me
 * is also mine". A role with no parents is a root; anything else would be
 * drawn twice.
 */
function Tree({ role, byId }: { role: RoleRow; byId: Map<string, RoleRow> }) {
  return (
    <li>
      <span>{role.name}</span> <span className="small muted">({role.key})</span>
      {role.children.length > 0 ? (
        <ul className="tree">
          {role.children.map((child) => {
            const full = byId.get(child.id);
            return full ? (
              <Tree key={child.id} role={full} byId={byId} />
            ) : (
              <li key={child.id}>{child.name}</li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

export default function RolesPage() {
  const { permissions, account } = useAuth();
  // A team account cannot be granted the platform tools, so the grid draws them
  // locked and the payload sends them empty. See lockedToolsFor.
  const lockedTools = lockedToolsFor(account?.teamId);
  const roles = useApi<Paginated<RoleRow>>("/roles?pageSize=100");
  // The tree, for scoping a role to some departments and not others.
  const groups = useApi<GroupTreeRow[]>("/groups/tree");
  // The hierarchy with its transitive closure, so the page can show that a role
  // bound to a second bound to a third is bound to the third as well.
  const graph = useApi<RoleGraphRow>("/roles/graph");
  const mutation = useMutation();

  const [panel, setPanel] = useState<Panel>({ kind: "closed" });
  const [draft, setDraft] = useState<RoleDraft>(EMPTY_ROLE_DRAFT);
  const [matrix, setMatrix] = useState<PermissionMatrixValue>({});
  const [newChild, setNewChild] = useState("");

  const mayCreate = can(permissions, "ROLES", "create");
  const mayUpdate = can(permissions, "ROLES", "update");
  const mayDelete = can(permissions, "ROLES", "delete");
  const mayEditPermissions = can(permissions, "PERMISSIONS", "update");

  function close() {
    setPanel({ kind: "closed" });
    setNewChild("");
    mutation.reset();
  }

  function openCreate() {
    setDraft(EMPTY_ROLE_DRAFT);
    setPanel({ kind: "form", role: null });
    mutation.reset();
  }

  function openEdit(role: RoleRow) {
    setDraft({
      key: role.key,
      name: role.name,
      description: role.description ?? "",
      placement: role.placement,
      groupScopeIds: role.groupScopeIds,
    });
    setPanel({ kind: "form", role });
    mutation.reset();
  }

  function openPermissions(role: RoleRow) {
    setMatrix(matrixFromPermissions(role.permissions));
    setPanel({ kind: "permissions", role });
    mutation.reset();
  }

  async function submitForm() {
    if (panel.kind !== "form") return;

    const body = roleBody(draft, panel.role !== null);

    const ok = await mutation.run(() =>
      panel.role ? apiClient.patch(`/roles/${panel.role.id}`, body) : apiClient.post("/roles", body)
    );
    if (ok) {
      close();
      roles.reload();
      graph.reload();
    }
  }

  // The whole matrix goes back. A tool left unchecked is denied, and inherited
  // permissions are never written here -- they resolve from the tree at request
  // time, so a change to the tree needs no data migration to follow it.
  async function submitPermissions() {
    if (panel.kind !== "permissions") return;

    const ok = await mutation.run(() =>
      apiClient.put(`/roles/${panel.role.id}/permissions`, {
        permissions: permissionsPayload(matrix, lockedTools),
      })
    );
    if (ok) {
      close();
      roles.reload();
    }
  }

  async function addChild(parentId: string) {
    if (!newChild) return;
    // A cycle here would hang every authorized request, so the server walks the
    // graph before writing and answers 409.
    if (await mutation.run(() => apiClient.post(`/roles/${parentId}/children/${newChild}`))) {
      setNewChild("");
      roles.reload();
      graph.reload();
    }
  }

  async function removeChild(parentId: string, childId: string) {
    if (await mutation.run(() => apiClient.delete(`/roles/${parentId}/children/${childId}`))) {
      roles.reload();
      graph.reload();
    }
  }

  async function remove(id: string) {
    if (await mutation.run(() => apiClient.delete(`/roles/${id}`))) {
      roles.reload();
      graph.reload();
    }
  }

  return (
    <>
      <PageHeader title="Roller">
        {mayCreate ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
            + Yeni rol
          </button>
        ) : null}
      </PageHeader>

      <AsyncSection state={roles}>
        {(data) => {
          const byId = new Map(data.items.map((role) => [role.id, role]));
          const roots = data.items.filter((role) => role.parents.length === 0);
          const editing = panel.kind === "form" ? panel.role : null;

          return (
            <div className="stack">
              {panel.kind === "form" ? (
                <FormPanel
                  title={editing ? `${editing.key} — duzenle` : "Yeni rol"}
                  error={mutation.error}
                  saving={mutation.saving}
                  onSubmit={submitForm}
                  onCancel={close}
                >
                  <RoleFields
                    draft={draft}
                    onChange={setDraft}
                    groups={groups}
                    editing={editing !== null}
                    error={mutation.error}
                  />

                  {editing ? (
                    <div className="stack-sm">
                      <p className="card-title" style={{ margin: 0 }}>
                        Alt roller (yetkileri devralinir)
                      </p>
                      {editing.children.length === 0 ? (
                        <span className="small muted">Alt rol yok.</span>
                      ) : (
                        editing.children.map((child) => (
                          <div key={child.id} className="row">
                            <span className="small">{child.name}</span>
                            <button
                              className="btn btn-sm"
                              type="button"
                              onClick={() => void removeChild(editing.id, child.id)}
                            >
                              Cikar
                            </button>
                          </div>
                        ))
                      )}
                      <div className="row">
                        <select value={newChild} onChange={(event) => setNewChild(event.target.value)}>
                          <option value="">Alt rol ekle...</option>
                          {data.items
                            .filter(
                              (role) =>
                                role.id !== editing.id &&
                                !editing.children.some((child) => child.id === role.id)
                            )
                            .map((role) => (
                              <option key={role.id} value={role.id}>
                                {role.name}
                              </option>
                            ))}
                        </select>
                        <button
                          className="btn btn-sm"
                          type="button"
                          disabled={!newChild}
                          onClick={() => void addChild(editing.id)}
                        >
                          Ekle
                        </button>
                      </div>
                    </div>
                  ) : null}
                </FormPanel>
              ) : null}

              {panel.kind === "permissions" ? (
                <FormPanel
                  title={`${panel.role.name} — yetkiler`}
                  error={mutation.error}
                  saving={mutation.saving}
                  onSubmit={submitPermissions}
                  onCancel={close}
                >
                  <p className="small muted" style={{ margin: 0 }}>
                    Yalnizca dogrudan verilen yetkiler. Alt rollerden devralinanlar burada
                    isaretli gorunmez; istek aninda hiyerarsiden cozulur.
                  </p>
                  <PermissionMatrix value={matrix} onChange={setMatrix} lockedTools={lockedTools} />
                </FormPanel>
              ) : null}

              {panel.kind === "closed" && mutation.error ? (
                <ErrorBox error={mutation.error} />
              ) : null}

              <div>
                <h2>Hiyerarsi</h2>
                <p className="small muted" style={{ marginTop: 0 }}>
                  Girinti &quot;ustundedir&quot; demektir: bir rol, altindaki her rolun
                  yetkilerini devralir. Yetkiyi en alta eklemek yukaridakilerin hepsine ulasir.
                </p>
                <div className="card">
                  <ul className="tree" style={{ borderLeft: "none", paddingLeft: 0 }}>
                    {roots.map((role) => (
                      <Tree key={role.id} role={role} byId={byId} />
                    ))}
                  </ul>
                </div>
              </div>

              <div>
                <h2>Roller</h2>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Rol</th>
                        <th>Anahtar</th>
                        <th>Konum</th>
                        <th>Kapsam</th>
                        <th className="numeric">Atanmis</th>
                        <th>Tur</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((role) => (
                        <tr key={role.id}>
                          <td>{role.name}</td>
                          <td className="muted small">{role.key}</td>
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
                          <td className="numeric">{role.assignedCount}</td>
                          <td>{role.isSystemRole ? <Badge>Sistem</Badge> : "—"}</td>
                          <td>
                            <RowActions>
                              {mayEditPermissions ? (
                                <button
                                  className="btn btn-sm"
                                  type="button"
                                  onClick={() => openPermissions(role)}
                                >
                                  Yetkiler
                                </button>
                              ) : null}
                              {mayUpdate ? (
                                <button
                                  className="btn btn-sm"
                                  type="button"
                                  onClick={() => openEdit(role)}
                                >
                                  Duzenle
                                </button>
                              ) : null}
                              {/* Kept even for a system role: the 409 explains
                                  why better than a missing button does. */}
                              {mayDelete ? (
                                <ConfirmButton
                                  question={`${role.name} silinsin mi?`}
                                  onConfirm={() => void remove(role.id)}
                                >
                                  Sil
                                </ConfirmButton>
                              ) : null}
                            </RowActions>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="small muted">
                  Sira yalnizca goruntuleme icindir. Kimin kimden yetki devraldigini yukaridaki
                  hiyerarsi belirler, bu sutun degil.
                </p>
              </div>

              <div>
                <h2>Izin matrisi</h2>
                <p className="small muted" style={{ marginTop: 0 }}>
                  O = okuma, E = ekleme, G = guncelleme, S = silme.
                </p>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Rol</th>
                        {TOOL_KEYS.map((tool) => (
                          <th key={tool} className="numeric small">
                            {tool}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((role) => (
                        <tr key={role.id}>
                          <td>{role.name}</td>
                          {TOOL_KEYS.map((tool) => {
                            const permission = role.permissions.find(
                              (entry) => entry.tool === tool
                            );
                            const flags = permission
                              ? PERMISSION_ACTIONS.map((action) =>
                                  permission[action.key] ? action.short : "·"
                                ).join("")
                              : "····";

                            return (
                              <td key={tool} className="numeric small">
                                <span className={permission ? "" : "muted"}>{flags}</span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          );
        }}
      </AsyncSection>
    </>
  );
}
