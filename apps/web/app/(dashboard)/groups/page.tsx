"use client";

import { useEffect, useState } from "react";
import { flattenGroupTree, type Paginated } from "@breakpoint/types";

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
import { CheckboxField, FormPanel, SelectField, TextAreaField, TextField } from "@/components/ui/form";
import {
  ToolStateGrid,
  toolStatesFrom,
  toolStatesPayload,
  type ToolStates,
} from "@/components/groups/tool-state-grid";
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
  const [draft, setDraft] = useState({
    name: "",
    description: "",
    parentId: "",
    isActive: true,
  });
  // What this group states for itself. See ToolStates: the third state is the
  // tool being absent from the map, which lets the parent answer instead.
  const [tools, setTools] = useState<ToolStates>(new Map());
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
    setDraft({ name: "", description: "", parentId: "", isActive: true });
    setPanel({ kind: "form", id: null });
    mutation.reset();
  }

  function openEdit(group: GroupRow) {
    setDraft({
      name: group.name,
      description: group.description ?? "",
      parentId: group.parentId ?? "",
      isActive: group.isActive,
    });
    setPanel({ kind: "form", id: group.id });
    mutation.reset();
  }

  function openTools(group: GroupRow) {
    // Only the rows this group states for itself. An inherited answer is shown
    // beside the control rather than pre-selected, or saving an untouched form
    // would turn every inherited value into a local one.
    setTools(toolStatesFrom(group.tools));
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
      // "" is the root, which the API spells as null.
      parentId: emptyToNull(draft.parentId),
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

  // Whole set, and only what this group states: a tool left out of the list
  // states nothing and inherits from the parent, which is not the same as
  // stating "off".
  async function submitTools() {
    if (panel.kind !== "tools") return;

    const ok = await mutation.run(() =>
      apiClient.put(`/groups/${panel.group.id}/tools`, { tools: toolStatesPayload(tools) })
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
          <SelectField
            label="Ust grup"
            value={draft.parentId}
            hint="Bos birakilirsa ana grup olur. Derinlik sinirli degil: Teknik > Mekanik > Tasarim."
            options={[
              { value: "", label: "— Ana grup —" },
              ...flattenGroupTree(groups.data?.items ?? [])
                // A group cannot be its own parent, and the server refuses a
                // descendant too -- offering either would be a guaranteed 409.
                .filter(({ group }) => group.id !== panel.id)
                .map(({ group, depth }) => ({
                  value: group.id,
                  label: `${"  ".repeat(depth)}${group.name}`,
                })),
            ]}
            onChange={(parentId) => setDraft({ ...draft, parentId })}
            error={issueFor(mutation.error, "parentId")}
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
          <ToolStateGrid
            value={tools}
            effective={panel.group.effectiveTools}
            onChange={setTools}
          />
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
        {(data) => {
          const byId = new Map(data.items.map((group) => [group.id, group]));

          // Depth-first, so a subgroup is drawn under the group it belongs to
          // rather than wherever the name happens to sort.
          return (
          <div className="grid">
            {flattenGroupTree(data.items).map(({ group, depth }) => (
              <Card key={group.id} title={group.name}>
                <div className="stack-sm">
                  {group.parentId ? (
                    <p className="small muted" style={{ margin: 0 }}>
                      Ust grup: {byId.get(group.parentId)?.name ?? "—"}
                      {depth > 1 ? ` (${depth}. seviye)` : ""}
                    </p>
                  ) : null}
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
                    {/* The effective set, not what this group states: a module
                        inherited from three levels up is just as open, and a
                        card showing only local rows would read as "none". */}
                    <div className="row">
                      {group.effectiveTools.filter((tool) => tool.isEnabled).length === 0 ? (
                        <span className="small muted">Yok</span>
                      ) : (
                        group.effectiveTools
                          .filter((tool) => tool.isEnabled)
                          .map((tool) => (
                            <Badge key={tool.tool} tone={tool.inheritedFrom ? "off" : undefined}>
                              {tool.tool}
                              {tool.inheritedFrom ? " ↑" : ""}
                            </Badge>
                          ))
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
                        question={
                          // Which of the two happens depends on what the
                          // department has done, and the person pressing it
                          // should know that before they press it.
                          `${group.name} ve altindaki tum alt gruplar kaldirilsin mi? ` +
                          "Gorev, toplanti veya finans kaydi varsa gecmis korunur ve grup pasife alinir; " +
                          "yoksa tamamen silinir."
                        }
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
          );
        }}
      </AsyncSection>
    </>
  );
}
