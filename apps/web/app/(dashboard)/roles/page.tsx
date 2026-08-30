"use client";

import { useState } from "react";
import { TOOL_KEYS, type Paginated, type ToolKey } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import {
  AsyncSection,
  Badge,
  ConfirmButton,
  ErrorBox,
  PageHeader,
  RowActions,
} from "@/components/ui";
import { FormPanel, SelectField, TextAreaField, TextField } from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { RoleRow, ToolRow } from "@/lib/api-types";
import { emptyToNull } from "@/lib/form-helpers";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";

const ACTIONS = [
  { key: "canRead", short: "O" },
  { key: "canCreate", short: "E" },
  { key: "canUpdate", short: "G" },
  { key: "canDelete", short: "S" },
] as const;

type Flags = Record<(typeof ACTIONS)[number]["key"], boolean>;
type Matrix = Record<string, Flags>;

const NO_FLAGS: Flags = { canRead: false, canCreate: false, canUpdate: false, canDelete: false };

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
  const { permissions } = useAuth();
  const roles = useApi<Paginated<RoleRow>>("/roles?pageSize=100");
  const tools = useApi<ToolRow[]>("/tools");
  const mutation = useMutation();

  const [panel, setPanel] = useState<Panel>({ kind: "closed" });
  const [draft, setDraft] = useState({
    key: "",
    name: "",
    description: "",
    scope: "GROUP",
    hierarchyLevel: "100",
  });
  const [matrix, setMatrix] = useState<Matrix>({});
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
    setDraft({ key: "", name: "", description: "", scope: "GROUP", hierarchyLevel: "100" });
    setPanel({ kind: "form", role: null });
    mutation.reset();
  }

  function openEdit(role: RoleRow) {
    setDraft({
      key: role.key,
      name: role.name,
      description: role.description ?? "",
      scope: role.scope,
      hierarchyLevel: String(role.hierarchyLevel),
    });
    setPanel({ kind: "form", role });
    mutation.reset();
  }

  function openPermissions(role: RoleRow) {
    setMatrix(
      Object.fromEntries(
        TOOL_KEYS.map((tool) => {
          const stored = role.permissions.find((entry) => entry.tool === tool);
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
      )
    );
    setPanel({ kind: "permissions", role });
    mutation.reset();
  }

  async function submitForm() {
    if (panel.kind !== "form") return;

    const body = panel.role
      ? {
          // key and scope are omitted: updateRoleSchema refuses both.
          name: draft.name,
          description: emptyToNull(draft.description),
          hierarchyLevel: Number(draft.hierarchyLevel),
        }
      : {
          key: draft.key,
          name: draft.name,
          description: emptyToNull(draft.description),
          scope: draft.scope,
          hierarchyLevel: Number(draft.hierarchyLevel),
        };

    const ok = await mutation.run(() =>
      panel.role ? apiClient.patch(`/roles/${panel.role.id}`, body) : apiClient.post("/roles", body)
    );
    if (ok) {
      close();
      roles.reload();
    }
  }

  // The whole matrix goes back. A tool left unchecked is denied, and inherited
  // permissions are never written here -- they resolve from the tree at request
  // time, so a change to the tree needs no data migration to follow it.
  async function submitPermissions() {
    if (panel.kind !== "permissions") return;

    const ok = await mutation.run(() =>
      apiClient.put(`/roles/${panel.role.id}/permissions`, {
        permissions: TOOL_KEYS.map((tool) => ({ tool, ...(matrix[tool] ?? NO_FLAGS) })),
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
    }
  }

  async function removeChild(parentId: string, childId: string) {
    if (await mutation.run(() => apiClient.delete(`/roles/${parentId}/children/${childId}`))) {
      roles.reload();
    }
  }

  async function remove(id: string) {
    if (await mutation.run(() => apiClient.delete(`/roles/${id}`))) roles.reload();
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
                  <TextField
                    label="Anahtar"
                    value={draft.key}
                    required={!editing}
                    disabled={!!editing}
                    placeholder="ARSIV_SORUMLUSU"
                    hint={
                      editing
                        ? "Degistirilemez: kodun eslestirdigi sey budur."
                        : "BUYUK_HARF ve alt cizgi."
                    }
                    onChange={(key) => setDraft({ ...draft, key })}
                    error={issueFor(mutation.error, "key")}
                  />
                  <TextField
                    label="Ad"
                    value={draft.name}
                    required
                    onChange={(name) => setDraft({ ...draft, name })}
                    error={issueFor(mutation.error, "name")}
                  />
                  <TextAreaField
                    label="Aciklama"
                    rows={2}
                    value={draft.description}
                    onChange={(description) => setDraft({ ...draft, description })}
                    error={issueFor(mutation.error, "description")}
                  />
                  <SelectField
                    label="Kapsam"
                    value={draft.scope}
                    disabled={!!editing}
                    hint={
                      editing
                        ? "Degistirilemez: mevcut atamalar modelin yasakladigi bir hale duserdi."
                        : "Grup ici rol, atandigi departmanda gecerlidir."
                    }
                    options={[
                      { value: "GROUP", label: "Grup ici" },
                      { value: "GLOBAL", label: "Takim geneli" },
                    ]}
                    onChange={(scope) => setDraft({ ...draft, scope })}
                    error={issueFor(mutation.error, "scope")}
                  />
                  <TextField
                    label="Siralama"
                    type="number"
                    value={draft.hierarchyLevel}
                    hint="Yalnizca goruntuleme sirasi. Yetki devri hiyerarsi agacindan gelir."
                    onChange={(hierarchyLevel) => setDraft({ ...draft, hierarchyLevel })}
                    error={issueFor(mutation.error, "hierarchyLevel")}
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
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Modul</th>
                          {ACTIONS.map((action) => (
                            <th key={action.key} className="numeric">
                              {action.short}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {TOOL_KEYS.map((tool) => (
                          <tr key={tool}>
                            <td>{tool}</td>
                            {ACTIONS.map((action) => (
                              <td key={action.key} className="numeric">
                                <input
                                  type="checkbox"
                                  checked={matrix[tool]?.[action.key] ?? false}
                                  onChange={(event) =>
                                    setMatrix((current) => ({
                                      ...current,
                                      [tool]: {
                                        ...(current[tool] ?? NO_FLAGS),
                                        [action.key]: event.target.checked,
                                      },
                                    }))
                                  }
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
                        <th>Kapsam</th>
                        <th className="numeric">Sira</th>
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
                            <Badge tone={role.scope === "GLOBAL" ? "warn" : "off"}>
                              {role.scope === "GLOBAL" ? "Takim geneli" : "Grup ici"}
                            </Badge>
                          </td>
                          <td className="numeric">{role.hierarchyLevel}</td>
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
                <AsyncSection state={tools}>
                  {(toolList) => (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Rol</th>
                            {toolList.map((tool) => (
                              <th key={tool.id} className="numeric small" title={tool.name}>
                                {tool.key}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {data.items.map((role) => (
                            <tr key={role.id}>
                              <td>{role.name}</td>
                              {toolList.map((tool) => {
                                const permission = role.permissions.find(
                                  (entry) => entry.tool === tool.key
                                );
                                const flags = permission
                                  ? ACTIONS.map((action) =>
                                      permission[action.key] ? action.short : "·"
                                    ).join("")
                                  : "····";

                                return (
                                  <td key={tool.id} className="numeric small">
                                    <span className={permission ? "" : "muted"}>{flags}</span>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </AsyncSection>
              </div>
            </div>
          );
        }}
      </AsyncSection>
    </>
  );
}
