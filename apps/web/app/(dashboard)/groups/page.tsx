"use client";

import { useEffect, useState } from "react";
import { TOOL_KEYS, type Paginated, type ToolKey } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import {
  AsyncSection,
  Badge,
  Card,
  ConfirmButton,
  ErrorBox,
  PageHeader,
  RowActions,
} from "@/components/ui";
import { CheckboxField, FormPanel, TextAreaField, TextField } from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { AccountRow, GroupRow } from "@/lib/api-types";
import { emptyToNull } from "@/lib/form-helpers";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";

type Panel =
  | { kind: "closed" }
  | { kind: "form"; id: string | null }
  | { kind: "tools"; group: GroupRow }
  | { kind: "members"; group: GroupRow };

export default function GroupsPage() {
  const { permissions } = useAuth();
  const groups = useApi<Paginated<GroupRow>>("/groups?pageSize=100&includeInactive=true");
  const mutation = useMutation();

  const [panel, setPanel] = useState<Panel>({ kind: "closed" });
  const [draft, setDraft] = useState({ name: "", description: "", isActive: true });
  const [tools, setTools] = useState<Set<ToolKey>>(new Set());
  const [members, setMembers] = useState<Set<string>>(new Set());

  // Only loaded while the members editor is open: the roster of everyone, so
  // people can be added, not just removed.
  const accounts = useApi<Paginated<AccountRow>>(
    panel.kind === "members" ? "/accounts?pageSize=200" : null
  );

  // Seeded from the loaded roster. Doing this during render would be a
  // setState in the render phase, which React re-runs until it settles.
  useEffect(() => {
    if (panel.kind !== "members" || !accounts.data) return;

    const groupId = panel.group.id;
    setMembers(
      new Set(
        accounts.data.items
          .filter((account) => account.groups.some((group) => group.id === groupId))
          .map((account) => account.id)
      )
    );
  }, [panel, accounts.data]);

  const mayCreate = can(permissions, "GROUPS", "create");
  const mayDelete = can(permissions, "GROUPS", "delete");

  function close() {
    setPanel({ kind: "closed" });
    mutation.reset();
  }

  function openCreate() {
    setDraft({ name: "", description: "", isActive: true });
    setPanel({ kind: "form", id: null });
    mutation.reset();
  }

  function openEdit(group: GroupRow) {
    setDraft({
      name: group.name,
      description: group.description ?? "",
      isActive: group.isActive,
    });
    setPanel({ kind: "form", id: group.id });
    mutation.reset();
  }

  function openTools(group: GroupRow) {
    setTools(
      new Set(
        group.tools.filter((tool) => tool.isEnabled).map((tool) => tool.tool as ToolKey)
      )
    );
    setPanel({ kind: "tools", group });
    mutation.reset();
  }

  function openMembers(group: GroupRow) {
    setMembers(new Set());
    setPanel({ kind: "members", group });
    mutation.reset();
  }

  async function submitForm() {
    const body = {
      name: draft.name,
      description: emptyToNull(draft.description),
      isActive: draft.isActive,
    };
    const id = panel.kind === "form" ? panel.id : null;

    const ok = await mutation.run(() =>
      id ? apiClient.patch(`/groups/${id}`, body) : apiClient.post("/groups", body)
    );
    if (ok) {
      close();
      groups.reload();
    }
  }

  // Whole set: a tool left out of the list is off, which is the same thing a
  // missing GroupTool row means to authorize().
  async function submitTools() {
    if (panel.kind !== "tools") return;

    const ok = await mutation.run(() =>
      apiClient.put(`/groups/${panel.group.id}/tools`, {
        tools: TOOL_KEYS.map((tool) => ({ tool, isEnabled: tools.has(tool) })),
      })
    );
    if (ok) {
      close();
      groups.reload();
    }
  }

  async function submitMembers() {
    if (panel.kind !== "members") return;

    const ok = await mutation.run(() =>
      apiClient.put(`/groups/${panel.group.id}/members`, { accountIds: [...members] })
    );
    if (ok) {
      close();
      groups.reload();
    }
  }

  async function remove(id: string) {
    if (await mutation.run(() => apiClient.delete(`/groups/${id}`))) groups.reload();
  }

  return (
    <>
      <PageHeader title="Gruplar">
        {mayCreate ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
            + Yeni grup
          </button>
        ) : null}
      </PageHeader>

      {panel.kind === "form" ? (
        <FormPanel
          title={panel.id ? "Grubu duzenle" : "Yeni grup"}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submitForm}
          onCancel={close}
        >
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
          <CheckboxField
            label="Aktif"
            checked={draft.isActive}
            onChange={(isActive) => setDraft({ ...draft, isActive })}
          />
        </FormPanel>
      ) : null}

      {panel.kind === "tools" ? (
        <FormPanel
          title={`${panel.group.name} — acik moduller`}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submitTools}
          onCancel={close}
        >
          <p className="small muted" style={{ margin: 0 }}>
            Isaretlenmeyen modul bu departman icin kapalidir ve istek, rol hic okunmadan
            reddedilir.
          </p>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
            {TOOL_KEYS.map((tool) => (
              <CheckboxField
                key={tool}
                label={tool}
                checked={tools.has(tool)}
                onChange={(checked) =>
                  setTools((current) => {
                    const next = new Set(current);
                    if (checked) next.add(tool);
                    else next.delete(tool);
                    return next;
                  })
                }
              />
            ))}
          </div>
        </FormPanel>
      ) : null}

      {panel.kind === "members" ? (
        <FormPanel
          title={`${panel.group.name} — uyeler`}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submitMembers}
          onCancel={close}
        >
          <AsyncSection state={accounts}>
            {(data) => {
              const groupId = panel.group.id;

              return (
                <>
                  <p className="small muted" style={{ margin: 0 }}>
                    Bu grupta rolu olanlar cikarilamaz — servis reddediyor, cunku rol uyelik
                    olmadan kullanilamaz hale gelirdi. Once rolu kaldirin.
                  </p>
                  <div className="stack-sm">
                    {data.items.map((account) => {
                      const holdsRole = account.roles.some((role) => role.groupId === groupId);

                      return (
                        <CheckboxField
                          key={account.id}
                          label={account.fullName}
                          hint={holdsRole ? "(bu grupta rolu var)" : undefined}
                          disabled={holdsRole}
                          checked={holdsRole || members.has(account.id)}
                          onChange={(checked) =>
                            setMembers((current) => {
                              const next = new Set(current);
                              if (checked) next.add(account.id);
                              else next.delete(account.id);
                              return next;
                            })
                          }
                        />
                      );
                    })}
                  </div>
                </>
              );
            }}
          </AsyncSection>
        </FormPanel>
      ) : null}

      {panel.kind === "closed" && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={groups}>
        {(data) => (
          <div className="grid">
            {data.items.map((group) => (
              <Card key={group.id} title={group.name}>
                <div className="stack-sm">
                  <p className="muted small" style={{ margin: 0 }}>
                    {group.description ?? "Aciklama yok."}
                  </p>

                  <div className="row">
                    <Badge tone={group.isActive ? "ok" : "off"}>
                      {group.isActive ? "Aktif" : "Pasif"}
                    </Badge>
                    <span className="small muted">{group.memberCount} uye</span>
                  </div>

                  <div>
                    <p className="card-title" style={{ marginBottom: 4 }}>
                      Acik moduller
                    </p>
                    <div className="row">
                      {group.tools.filter((tool) => tool.isEnabled).length === 0 ? (
                        <span className="small muted">Yok</span>
                      ) : (
                        group.tools
                          .filter((tool) => tool.isEnabled)
                          .map((tool) => <Badge key={tool.toolId}>{tool.tool}</Badge>)
                      )}
                    </div>
                  </div>

                  <RowActions>
                    {/* Membership is a GROUPS/update on this group; switching a
                        module on is TOOLS/update, which a lead does not have. */}
                    {can(permissions, "GROUPS", "update", group.id) ? (
                      <button className="btn btn-sm" type="button" onClick={() => openMembers(group)}>
                        Uyeler
                      </button>
                    ) : null}
                    {can(permissions, "TOOLS", "update") ? (
                      <button className="btn btn-sm" type="button" onClick={() => openTools(group)}>
                        Moduller
                      </button>
                    ) : null}
                    {can(permissions, "GROUPS", "update") ? (
                      <button className="btn btn-sm" type="button" onClick={() => openEdit(group)}>
                        Duzenle
                      </button>
                    ) : null}
                    {mayDelete ? (
                      <ConfirmButton
                        question={`${group.name} pasife alinsin mi?`}
                        onConfirm={() => void remove(group.id)}
                      >
                        Sil
                      </ConfirmButton>
                    ) : null}
                  </RowActions>
                </div>
              </Card>
            ))}
          </div>
        )}
      </AsyncSection>
    </>
  );
}
