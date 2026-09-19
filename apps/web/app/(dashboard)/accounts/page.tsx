"use client";

import { useEffect, useState } from "react";
import { Archive, Pencil, Plus, Upload } from "lucide-react";
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
import { CheckboxField, FormPanel, SelectField, TextField } from "@/components/ui/form";
import { BulkImportPanel } from "@/components/accounts/bulk-import-panel";
import {
  RoleAssignmentRows,
  roleAssignmentPayload,
  type RoleAssignmentDraft,
} from "@/components/accounts/role-assignment-rows";
import { useApi } from "@/hooks/use-api";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { AccountRow, GroupTreeRow, RoleRow } from "@/lib/api-types";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";

const PAGE_SIZE = 25;

type Panel =
  | { kind: "closed" }
  | { kind: "form"; account: AccountRow | null }
  | { kind: "roles"; account: AccountRow }
  | { kind: "password"; account: AccountRow }
  | { kind: "bulk" };

export default function AccountsPage() {
  const { groups: myGroups = [], permissions, account: me } = useAuth();
  // "Tüm takım" (no groupId) is an unscoped request, and authorize() only lets
  // a TEAM_WIDE/EXTERNAL role make one -- a department lead with no team-wide
  // ACCOUNTS grant would 403 on load with that as the default. Their own group
  // memberships are exactly the departments they run, so the first one is a
  // default that actually resolves; team-wide readers keep "Tüm takım" since
  // it works for them.
  const mayReadAccountsGlobally = can(permissions, "ACCOUNTS", "read");
  const [groupId, setGroupId] = useState(() =>
    mayReadAccountsGlobally ? "" : (myGroups[0]?.id ?? "")
  );
  const [searchDraft, setSearchDraft] = useState("");
  const search = useDebouncedValue(searchDraft);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Any filter changing invalidates the current page -- staying on page 3 of
  // a search that now has one page of results would just show "no results"
  // instead of the results that exist.
  useEffect(() => setPage(1), [groupId, search, includeArchived]);

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (groupId) params.set("groupId", groupId);
  if (search) params.set("search", search);
  if (includeArchived) params.set("includeArchived", "true");

  const accounts = useApi<Paginated<AccountRow>>(`/accounts?${params.toString()}`);
  const mutation = useMutation();

  const [panel, setPanel] = useState<Panel>({ kind: "closed" });
  const [draft, setDraft] = useState({ email: "", fullName: "", password: "", isActive: true });
  const [roleDrafts, setRoleDrafts] = useState<RoleAssignmentDraft[]>([]);
  const [password, setPassword] = useState("");

  // Assigning a role, or a bulk import's role picker, needs every role and
  // every group -- not just the ones the signed-in account belongs to.
  const needsCatalog = panel.kind === "roles" || panel.kind === "bulk";
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

    const ok = await mutation.run(
      () =>
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
            }),
      panel.account ? "Hesap güncellendi." : "Hesap oluşturuldu."
    );
    if (ok) {
      close();
      accounts.reload();
    }
  }

  async function submitRoles() {
    if (panel.kind !== "roles") return;

    const ok = await mutation.run(
      () =>
        apiClient.put(`/accounts/${panel.account.id}/roles`, {
          roles: roleAssignmentPayload(roleDrafts),
        }),
      "Roller güncellendi."
    );
    if (ok) {
      close();
      accounts.reload();
    }
  }

  async function submitPassword() {
    if (panel.kind !== "password") return;

    if (
      await mutation.run(
        () => apiClient.post(`/accounts/${panel.account.id}/password`, { password }),
        "Şifre değiştirildi."
      )
    ) {
      close();
    }
  }

  async function archive(id: string) {
    if (await mutation.run(() => apiClient.delete(`/accounts/${id}`), "Hesap arşivlendi.")) {
      accounts.reload();
    }
  }

  const activeFilterCount = [groupId, search, includeArchived ? "1" : ""].filter(Boolean).length;

  return (
    <>
      <PageHeader title="Hesaplar">
        {mayCreate ? (
          <>
            <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
              <Plus size={14} aria-hidden="true" />
              Yeni hesap
            </button>
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => {
                setPanel({ kind: "bulk" });
                mutation.reset();
              }}
            >
              <Upload size={14} aria-hidden="true" />
              CSV ile toplu ekle
            </button>
          </>
        ) : null}
      </PageHeader>

      <div className="filter-bar">
        <button
          type="button"
          className="btn btn-sm filters-toggle"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((value) => !value)}
        >
          Filtreler{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
        </button>

        <div className={`filter-panel${filtersOpen ? " is-open" : ""}`}>
          <TextField
            label="Ara"
            value={searchDraft}
            placeholder="Ad veya e-posta"
            onChange={setSearchDraft}
          />
          <SelectField
            label="Grup"
            value={groupId}
            placeholder="Tüm takım"
            options={myGroups.map((group) => ({ value: group.id, label: group.name }))}
            onChange={setGroupId}
          />
          <CheckboxField
            label="Arşivlenenleri göster"
            checked={includeArchived}
            onChange={setIncludeArchived}
          />
        </div>
      </div>

      {panel.kind === "form" ? (
        <FormPanel
          title={panel.account ? "Hesabı düzenle" : "Yeni hesap"}
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
              label="Şifre"
              type="password"
              value={draft.password}
              required
              hint="En az 10 karakter."
              onChange={(value) => setDraft({ ...draft, password: value })}
              error={issueFor(mutation.error, "password")}
            />
          ) : null}
          <CheckboxField
            label="Aktif (giriş yapabilir)"
            checked={draft.isActive}
            onChange={(isActive) => setDraft({ ...draft, isActive })}
          />
        </FormPanel>
      ) : null}

      {panel.kind === "password" ? (
        <FormPanel
          title={`${panel.account.fullName} — şifre sıfırla`}
          error={mutation.error}
          saving={mutation.saving}
          submitLabel="Şifreyi değiştir"
          onSubmit={submitPassword}
          onCancel={close}
        >
          <TextField
            label="Yeni şifre"
            type="password"
            value={password}
            required
            hint="Bu hesabın açık tüm oturumları kapatılır."
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
            Liste bütünüyle değiştirilir. Grup içi bir rol atandığında kişi o gruba da üye
            yapılır — aksi halde kendi departmanında reddedilirdi.
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

      {panel.kind === "bulk" ? (
        <AsyncSection state={roles}>
          {(roleList) => (
            <AsyncSection state={allGroups}>
              {(groupTree) => (
                <BulkImportPanel
                  roles={roleList.items}
                  groups={groupTree}
                  onImported={() => {
                    accounts.reload();
                  }}
                />
              )}
            </AsyncSection>
          )}
        </AsyncSection>
      ) : null}

      {panel.kind === "closed" && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={accounts} empty="Bu filtrelerle hesap yok.">
        {(data) => (
          <div className="stack-sm">
            <div className="table-wrap table-responsive-wrap">
              <table className="table table-responsive">
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
                      <td data-label="Ad">{account.fullName}</td>
                      <td className="muted" data-label="E-posta">
                        {account.email}
                      </td>
                      <td data-label="Roller">
                        {account.roles.length ? formatAccountRoles(account.roles) : "—"}
                      </td>
                      <td data-label="Gruplar">
                        <div className="row">
                          {account.groups.map((group) => (
                            <Badge key={group.id}>{group.name}</Badge>
                          ))}
                        </div>
                      </td>
                      <td data-label="Durum">
                        {account.archivedAt ? (
                          <Badge tone="off">Arşivlendi</Badge>
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
                              Şifre
                            </button>
                          ) : null}
                          {mayUpdate ? (
                            <button className="btn btn-sm" type="button" onClick={() => openEdit(account)}>
                              <Pencil size={14} aria-hidden="true" />
                              Düzenle
                            </button>
                          ) : null}
                          {/* Archiving yourself would revoke your own session
                              mid-request; the server refuses it too. */}
                          {mayDelete && account.id !== me?.id && !account.archivedAt ? (
                            <ConfirmButton
                              question={`${account.fullName} arşivlensin mi?`}
                              onConfirm={() => archive(account.id)}
                            >
                              <Archive size={14} aria-hidden="true" />
                              Arşivle
                            </ConfirmButton>
                          ) : null}
                        </RowActions>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="row pagination" aria-label="Sayfalama">
              <button
                className="btn btn-sm"
                type="button"
                disabled={data.page <= 1 || accounts.loading}
                onClick={() => setPage((value) => value - 1)}
              >
                Önceki
              </button>
              <span className="small muted">
                Sayfa {data.page} / {Math.max(data.totalPages, 1)} · {data.total} hesap
              </span>
              <button
                className="btn btn-sm"
                type="button"
                disabled={data.page >= data.totalPages || accounts.loading}
                onClick={() => setPage((value) => value + 1)}
              >
                Sonraki
              </button>
            </div>
          </div>
        )}
      </AsyncSection>
    </>
  );
}
