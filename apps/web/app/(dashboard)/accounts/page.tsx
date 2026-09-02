"use client";

import { useEffect, useState } from "react";
import { formatAccountRoles, type Paginated } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import {
  AsyncSection,
  Badge,
  ConfirmButton,
  ErrorBox,
  PageHeader,
  RowActions,
} from "@/components/ui";
import { CheckboxField, FormPanel, TextField } from "@/components/ui/form";
import {
  RoleAssignmentRows,
  roleAssignmentPayload,
  type RoleAssignmentDraft,
} from "@/components/accounts/role-assignment-rows";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { AccountRow, GroupTreeRow, RoleRow } from "@/lib/api-types";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";

type Panel =
  | { kind: "closed" }
  | { kind: "form"; account: AccountRow | null }
  | { kind: "roles"; account: AccountRow }
  | { kind: "password"; account: AccountRow };

export default function AccountsPage() {
  const { groups: myGroups = [], permissions, account: me } = useAuth();
  const [groupId, setGroupId] = useState("");

  const query = groupId ? `?groupId=${encodeURIComponent(groupId)}&pageSize=100` : "?pageSize=100";
  const accounts = useApi<Paginated<AccountRow>>(`/accounts${query}`);
  const mutation = useMutation();

  const [panel, setPanel] = useState<Panel>({ kind: "closed" });
  const [draft, setDraft] = useState({ email: "", fullName: "", password: "", isActive: true });
  const [roleDrafts, setRoleDrafts] = useState<RoleAssignmentDraft[]>([]);
  const [password, setPassword] = useState("");

  // Assigning a role needs every role and every group, not just the ones the
  // signed-in account belongs to.
  const needsCatalog = panel.kind === "roles";
  const roles = useApi<Paginated<RoleRow>>(needsCatalog ? "/roles?pageSize=100" : null);
  const allGroups = useApi<GroupTreeRow[]>(needsCatalog ? "/groups/tree" : null);

  const mayCreate = can(permissions, "ACCOUNTS", "create");
  const mayUpdate = can(permissions, "ACCOUNTS", "update");
  const mayDelete = can(permissions, "ACCOUNTS", "delete");
  const mayAssignRoles = can(permissions, "ROLES", "update");

  useEffect(() => {
    if (panel.kind !== "roles") return;
    setRoleDrafts(
      panel.account.roles.map((role) => ({ roleId: role.roleId, groupId: role.groupId ?? "" }))
    );
  }, [panel]);

  function close() {
    setPanel({ kind: "closed" });
    setPassword("");
    mutation.reset();
  }

  function openCreate() {
    setDraft({ email: "", fullName: "", password: "", isActive: true });
    setPanel({ kind: "form", account: null });
    mutation.reset();
  }

  function openEdit(account: AccountRow) {
    setDraft({
      email: account.email,
      fullName: account.fullName,
      password: "",
      isActive: account.isActive,
    });
    setPanel({ kind: "form", account });
    mutation.reset();
  }

  async function submitForm() {
    if (panel.kind !== "form") return;

    const ok = await mutation.run(() =>
      panel.account
        ? // Password is not here: changing it is its own endpoint, never a field
          // that rides along with a name change.
          apiClient.patch(`/accounts/${panel.account.id}`, {
            email: draft.email,
            fullName: draft.fullName,
            isActive: draft.isActive,
          })
        : apiClient.post("/accounts", {
            email: draft.email,
            fullName: draft.fullName,
            password: draft.password,
            isActive: draft.isActive,
            roles: [],
          })
    );
    if (ok) {
      close();
      accounts.reload();
    }
  }

  async function submitRoles() {
    if (panel.kind !== "roles") return;

    const ok = await mutation.run(() =>
      apiClient.put(`/accounts/${panel.account.id}/roles`, {
        roles: roleAssignmentPayload(roleDrafts),
      })
    );
    if (ok) {
      close();
      accounts.reload();
    }
  }

  async function submitPassword() {
    if (panel.kind !== "password") return;

    if (await mutation.run(() => apiClient.post(`/accounts/${panel.account.id}/password`, { password }))) {
      close();
    }
  }

  async function archive(id: string) {
    if (await mutation.run(() => apiClient.delete(`/accounts/${id}`))) accounts.reload();
  }

  return (
    <>
      <PageHeader title="Hesaplar">
        <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          <option value="">Tum takim</option>
          {myGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        {mayCreate ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
            + Yeni hesap
          </button>
        ) : null}
      </PageHeader>

      {panel.kind === "form" ? (
        <FormPanel
          title={panel.account ? "Hesabi duzenle" : "Yeni hesap"}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submitForm}
          onCancel={close}
        >
          <TextField
            label="E-posta"
            type="email"
            value={draft.email}
            required
            onChange={(email) => setDraft({ ...draft, email })}
            error={issueFor(mutation.error, "email")}
          />
          <TextField
            label="Ad soyad"
            value={draft.fullName}
            required
            onChange={(fullName) => setDraft({ ...draft, fullName })}
            error={issueFor(mutation.error, "fullName")}
          />
          {!panel.account ? (
            <TextField
              label="Sifre"
              type="password"
              value={draft.password}
              required
              hint="En az 10 karakter."
              onChange={(value) => setDraft({ ...draft, password: value })}
              error={issueFor(mutation.error, "password")}
            />
          ) : null}
          <CheckboxField
            label="Aktif (giris yapabilir)"
            checked={draft.isActive}
            onChange={(isActive) => setDraft({ ...draft, isActive })}
          />
        </FormPanel>
      ) : null}

      {panel.kind === "password" ? (
        <FormPanel
          title={`${panel.account.fullName} — sifre sifirla`}
          error={mutation.error}
          saving={mutation.saving}
          submitLabel="Sifreyi degistir"
          onSubmit={submitPassword}
          onCancel={close}
        >
          <TextField
            label="Yeni sifre"
            type="password"
            value={password}
            required
            hint="Bu hesabin acik tum oturumlari kapatilir."
            onChange={setPassword}
            error={issueFor(mutation.error, "password")}
          />
        </FormPanel>
      ) : null}

      {panel.kind === "roles" ? (
        <FormPanel
          title={`${panel.account.fullName} — roller`}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submitRoles}
          onCancel={close}
        >
          <p className="small muted" style={{ margin: 0 }}>
            Liste butunuyle degistirilir. Grup ici bir rol atandiginda kisi o gruba da uye
            yapilir — aksi halde kendi departmaninda reddedilirdi.
          </p>

          <AsyncSection state={roles}>
            {(roleList) => (
              <AsyncSection state={allGroups}>
                {(groupTree) => (
                  <RoleAssignmentRows
                    value={roleDrafts}
                    onChange={setRoleDrafts}
                    roles={roleList.items}
                    groups={groupTree}
                    error={mutation.error}
                  />
                )}
              </AsyncSection>
            )}
          </AsyncSection>
        </FormPanel>
      ) : null}

      {panel.kind === "closed" && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={accounts}>
        {(data) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>E-posta</th>
                  <th>Roller</th>
                  <th>Gruplar</th>
                  <th>Durum</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((account) => (
                  <tr key={account.id}>
                    <td>{account.fullName}</td>
                    <td className="muted">{account.email}</td>
                    <td>{account.roles.length ? formatAccountRoles(account.roles) : "—"}</td>
                    <td>
                      <div className="row">
                        {account.groups.map((group) => (
                          <Badge key={group.id}>{group.name}</Badge>
                        ))}
                      </div>
                    </td>
                    <td>
                      {account.archivedAt ? (
                        <Badge tone="off">Arsivlendi</Badge>
                      ) : account.isActive ? (
                        <Badge tone="ok">Aktif</Badge>
                      ) : (
                        <Badge tone="warn">Pasif</Badge>
                      )}
                    </td>
                    <td>
                      <RowActions>
                        {mayAssignRoles ? (
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => setPanel({ kind: "roles", account })}
                          >
                            Roller
                          </button>
                        ) : null}
                        {mayUpdate ? (
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => {
                              setPassword("");
                              setPanel({ kind: "password", account });
                              mutation.reset();
                            }}
                          >
                            Sifre
                          </button>
                        ) : null}
                        {mayUpdate ? (
                          <button className="btn btn-sm" type="button" onClick={() => openEdit(account)}>
                            Duzenle
                          </button>
                        ) : null}
                        {/* Archiving yourself would revoke your own session
                            mid-request; the server refuses it too. */}
                        {mayDelete && account.id !== me?.id && !account.archivedAt ? (
                          <ConfirmButton
                            question={`${account.fullName} arsivlensin mi?`}
                            onConfirm={() => void archive(account.id)}
                          >
                            Arsivle
                          </ConfirmButton>
                        ) : null}
                      </RowActions>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncSection>
    </>
  );
}
