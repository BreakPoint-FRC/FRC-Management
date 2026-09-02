"use client";

import { useState } from "react";
import { formatAccountRoles, type Paginated } from "@breakpoint/types";

import {
  RoleAssignmentRows,
  roleAssignmentPayload,
  type RoleAssignmentDraft,
} from "@/components/accounts/role-assignment-rows";
import { AsyncSection, Badge, ErrorBox } from "@/components/ui";
import { FormPanel, TextField } from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { AccountRow, GroupTreeRow, RoleRow } from "@/lib/api-types";
import { issueFor } from "@/lib/issues";

const EMPTY = { email: "", fullName: "", password: "" };

/**
 * The last step: the people, and what each of them is.
 *
 * Account and roles go in one request -- POST /accounts takes the role list --
 * so a person is never created and then left with nothing, which is the state
 * someone would have to remember to come back and fix.
 *
 * The password typed here is temporary by construction: the server flags every
 * account an admin creates, and the account can do nothing but change it at
 * first sign-in. There is no mail sending in this project, so it has to be read
 * off this screen and handed over.
 */
export function AccountsStep() {
  const accounts = useApi<Paginated<AccountRow>>("/accounts?pageSize=100");
  const roles = useApi<Paginated<RoleRow>>("/roles?pageSize=100");
  const groups = useApi<GroupTreeRow[]>("/groups/tree");
  const mutation = useMutation();

  const [draft, setDraft] = useState(EMPTY);
  const [roleDrafts, setRoleDrafts] = useState<RoleAssignmentDraft[]>([]);

  async function submit() {
    const ok = await mutation.run(() =>
      apiClient.post("/accounts", { ...draft, roles: roleAssignmentPayload(roleDrafts) })
    );
    if (!ok) return;

    setDraft(EMPTY);
    setRoleDrafts([]);
    accounts.reload();
  }

  return (
    <div className="stack-sm">
      <AsyncSection state={accounts}>
        {(data) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Ad soyad</th>
                  <th>E-posta</th>
                  <th>Roller</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((account) => (
                  <tr key={account.id}>
                    <td>{account.fullName}</td>
                    <td className="muted small">{account.email}</td>
                    <td className="small">
                      {account.roles.length === 0 ? "—" : formatAccountRoles(account.roles)}
                    </td>
                    <td>
                      {/* Worth saying on this screen: whoever created the
                          account knows its password, so it is not yet a
                          credential. */}
                      {account.mustChangePassword ? (
                        <Badge tone="warn">Sifre bekliyor</Badge>
                      ) : (
                        <Badge tone="ok">Hazir</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncSection>

      <FormPanel
        title="Hesap ekle"
        error={mutation.error}
        saving={mutation.saving}
        submitLabel="Hesabi olustur"
        onSubmit={submit}
        onCancel={() => {
          setDraft(EMPTY);
          setRoleDrafts([]);
          mutation.reset();
        }}
      >
        <TextField
          label="Ad soyad"
          value={draft.fullName}
          required
          onChange={(fullName) => setDraft({ ...draft, fullName })}
          error={issueFor(mutation.error, "fullName")}
        />
        <TextField
          label="E-posta"
          type="email"
          value={draft.email}
          required
          onChange={(email) => setDraft({ ...draft, email })}
          error={issueFor(mutation.error, "email")}
        />
        <TextField
          label="Gecici sifre"
          value={draft.password}
          required
          hint="En az 10 karakter. Kisiye iletin: ilk giriste kendi sifresini belirlemeden baska hicbir sey yapamaz."
          onChange={(password) => setDraft({ ...draft, password })}
          error={issueFor(mutation.error, "password")}
        />

        <div className="field">
          <label>Roller</label>
          <p className="small muted" style={{ margin: "0 0 6px" }}>
            Grup ici bir rol atandiginda kisi o gruba da uye yapilir — aksi halde kendi
            departmaninda reddedilirdi.
          </p>
          <AsyncSection state={roles}>
            {(roleList) => (
              <AsyncSection state={groups}>
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
        </div>
      </FormPanel>
    </div>
  );
}
