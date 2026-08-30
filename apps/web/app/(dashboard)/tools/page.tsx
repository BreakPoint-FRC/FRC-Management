"use client";

import { useState } from "react";

import { useAuth } from "@/components/auth/auth-provider";
import {
  AsyncSection,
  Badge,
  ConfirmButton,
  ErrorBox,
  PageHeader,
  RowActions,
} from "@/components/ui";
import { CheckboxField, FormPanel, TextAreaField, TextField } from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { ToolRow } from "@/lib/api-types";
import { emptyToNull } from "@/lib/form-helpers";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";

/**
 * Modules are editable but not creatable.
 *
 * `Tool.key` is a closed enum in @breakpoint/types and every value already has
 * a row, because `authorize()` is called with those literals throughout the
 * API. A new module is a code change, not a form -- so there is no "add" button
 * here, rather than one that would always fail.
 */
export default function ToolsPage() {
  const { permissions } = useAuth();
  const tools = useApi<ToolRow[]>("/tools");
  const mutation = useMutation();

  const [editing, setEditing] = useState<ToolRow | null>(null);
  const [draft, setDraft] = useState({ name: "", description: "", isActive: true });

  const mayUpdate = can(permissions, "TOOLS", "update");
  const mayDelete = can(permissions, "TOOLS", "delete");

  function openEdit(tool: ToolRow) {
    setDraft({
      name: tool.name,
      description: tool.description ?? "",
      isActive: tool.isActive,
    });
    setEditing(tool);
    mutation.reset();
  }

  function close() {
    setEditing(null);
    mutation.reset();
  }

  async function submit() {
    if (!editing) return;

    const ok = await mutation.run(() =>
      apiClient.patch(`/tools/${editing.id}`, {
        name: draft.name,
        description: emptyToNull(draft.description),
        isActive: draft.isActive,
      })
    );
    if (ok) {
      close();
      tools.reload();
    }
  }

  async function deactivate(id: string) {
    if (await mutation.run(() => apiClient.delete(`/tools/${id}`))) tools.reload();
  }

  return (
    <>
      <PageHeader title="Moduller" />

      <p className="small muted">
        Yeni modul eklemek kod degisikligi ister: anahtar once{" "}
        <code>packages/types</code> icindeki kapali listeye girmeli, cunku yetki kontrolu bu
        anahtarlarla cagriliyor. Buradan ad, aciklama ve aktiflik duzenlenir. Bir modulu
        pasife almak onu herkes icin kapatir — sistem yoneticisi dahil — ama verilmis
        yetkilere dokunmaz.
      </p>

      {editing ? (
        <FormPanel
          title={`${editing.key} — duzenle`}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submit}
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

      {!editing && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={tools}>
        {(data) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Anahtar</th>
                  <th>Ad</th>
                  <th>Aciklama</th>
                  <th>Durum</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((tool) => (
                  <tr key={tool.id}>
                    <td className="small muted">{tool.key}</td>
                    <td>{tool.name}</td>
                    <td className="muted">{tool.description ?? "—"}</td>
                    <td>
                      <Badge tone={tool.isActive ? "ok" : "off"}>
                        {tool.isActive ? "Aktif" : "Pasif"}
                      </Badge>
                    </td>
                    <td>
                      <RowActions>
                        {mayUpdate ? (
                          <button className="btn btn-sm" type="button" onClick={() => openEdit(tool)}>
                            Duzenle
                          </button>
                        ) : null}
                        {mayDelete && tool.isActive ? (
                          <ConfirmButton
                            question={`${tool.name} modulu herkes icin kapatilsin mi?`}
                            onConfirm={() => void deactivate(tool.id)}
                          >
                            Pasife al
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
