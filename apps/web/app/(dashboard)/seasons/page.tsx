"use client";

import { useState } from "react";
import { CheckCircle2, Pencil, Plus, Trash2 } from "lucide-react";
import type { Paginated } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import { AsyncSection, Badge, ConfirmButton, ErrorBox, PageHeader, RowActions } from "@/components/ui";
import { FormPanel, TextField } from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { SeasonRow } from "@/lib/api-types";
import { formatDate, toDateInput } from "@/lib/format";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";

interface Draft {
  name: string;
  startDate: string;
  endDate: string;
}

const BLANK: Draft = { name: "", startDate: "", endDate: "" };

export default function SeasonsPage() {
  const { permissions } = useAuth();
  const seasons = useApi<Paginated<SeasonRow>>("/seasons?pageSize=100");
  const mutation = useMutation();

  // null = closed, "new" = create, anything else = the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);

  const mayCreate = can(permissions, "SEASONS", "create");
  const mayUpdate = can(permissions, "SEASONS", "update");
  const mayDelete = can(permissions, "SEASONS", "delete");

  function close() {
    setEditing(null);
    mutation.reset();
  }

  function openCreate() {
    setDraft(BLANK);
    setEditing("new");
    mutation.reset();
  }

  function openEdit(season: SeasonRow) {
    setDraft({
      name: season.name,
      startDate: toDateInput(season.startDate),
      endDate: toDateInput(season.endDate),
    });
    setEditing(season.id);
    mutation.reset();
  }

  async function submit() {
    const ok = await mutation.run(
      () =>
        editing === "new"
          ? apiClient.post("/seasons", draft)
          : apiClient.patch(`/seasons/${editing}`, draft),
      editing === "new" ? "Sezon oluşturuldu." : "Sezon güncellendi."
    );
    if (ok) {
      close();
      seasons.reload();
    }
  }

  async function remove(id: string) {
    // Refused for an active season, or one with records hanging off it. The
    // 409 explains which, and lands in the ErrorBox below.
    if (await mutation.run(() => apiClient.delete(`/seasons/${id}`), "Sezon silindi.")) {
      seasons.reload();
    }
  }

  async function activate(id: string) {
    if (await mutation.run(() => apiClient.post(`/seasons/${id}/activate`), "Sezon etkinleştirildi.")) {
      seasons.reload();
    }
  }

  return (
    <>
      <PageHeader title="Sezonlar">
        {mayCreate ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
            <Plus size={14} aria-hidden="true" />
            Yeni sezon
          </button>
        ) : null}
      </PageHeader>

      <p className="small muted">
        Görevler, toplantılar, finans kayıtları, sponsorluklar ve Gantt panoları bir sezona
        bağlıdır. Geçmiş sezonların kayıtları böylece okunabilir kalır ve bu sezonun toplamlarına
        karışmaz. Aynı anda yalnızca bir sezon aktiftir; birini aktifleştirmek diğerlerini pasife
        alır.
      </p>

      {editing ? (
        <FormPanel
          title={editing === "new" ? "Yeni sezon" : "Sezonu düzenle"}
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
          <div className="row">
            <TextField
              label="Başlangıç"
              type="date"
              value={draft.startDate}
              required
              onChange={(startDate) => setDraft({ ...draft, startDate })}
              error={issueFor(mutation.error, "startDate")}
            />
            <TextField
              label="Bitiş"
              type="date"
              value={draft.endDate}
              required
              onChange={(endDate) => setDraft({ ...draft, endDate })}
              error={issueFor(mutation.error, "endDate")}
            />
          </div>
        </FormPanel>
      ) : null}

      {/* A delete or activate failure has no form of its own to land in. */}
      {!editing && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={seasons}>
        {(data) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Sezon</th>
                  <th>Başlangıç</th>
                  <th>Bitiş</th>
                  <th className="numeric">Görev</th>
                  <th className="numeric">Toplantı</th>
                  <th className="numeric">Finans</th>
                  <th className="numeric">Sponsorluk</th>
                  <th className="numeric">Gantt</th>
                  <th>Durum</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((season) => (
                  <tr key={season.id}>
                    <td>{season.name}</td>
                    <td>{formatDate(season.startDate)}</td>
                    <td>{formatDate(season.endDate)}</td>
                    <td className="numeric">{season._count.tasks}</td>
                    <td className="numeric">{season._count.meetings}</td>
                    <td className="numeric">{season._count.transactions}</td>
                    <td className="numeric">{season._count.sponsorships}</td>
                    <td className="numeric">{season._count.ganttBoards}</td>
                    <td>
                      {season.isActive ? <Badge tone="ok">Aktif</Badge> : <Badge>Geçmiş</Badge>}
                    </td>
                    <td>
                      <RowActions>
                        {mayUpdate && !season.isActive ? (
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => void activate(season.id)}
                          >
                            <CheckCircle2 size={14} aria-hidden="true" />
                            Aktifleştir
                          </button>
                        ) : null}
                        {mayUpdate ? (
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => openEdit(season)}
                          >
                            <Pencil size={14} aria-hidden="true" />
                            Düzenle
                          </button>
                        ) : null}
                        {mayDelete ? (
                          <ConfirmButton
                            question={`${season.name} silinsin mi?`}
                            onConfirm={() => remove(season.id)}
                          >
                            <Trash2 size={14} aria-hidden="true" />
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
        )}
      </AsyncSection>
    </>
  );
}
