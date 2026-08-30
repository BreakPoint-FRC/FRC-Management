"use client";

import Link from "next/link";
import { useState } from "react";
import type { Paginated } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import {
  AsyncSection,
  ConfirmButton,
  ErrorBox,
  PageHeader,
  RowActions,
} from "@/components/ui";
import { FormPanel, SelectField, TextAreaField, TextField } from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import { emptyToNull, selectToNull } from "@/lib/form-helpers";
import { formatDate, toDateInput } from "@/lib/format";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";
import type { MeetingRow } from "@/lib/api-types";

interface Draft {
  title: string;
  meetingDate: string;
  groupId: string;
  body: string;
}

const BLANK: Draft = { title: "", meetingDate: "", groupId: "", body: "" };

export default function MeetingsPage() {
  const { groups = [], permissions } = useAuth();
  const [groupId, setGroupId] = useState("");

  const query = groupId ? `?groupId=${encodeURIComponent(groupId)}&pageSize=100` : "?pageSize=100";
  const meetings = useApi<Paginated<MeetingRow>>(`/meetings${query}`);
  const mutation = useMutation();

  const [editing, setEditing] = useState<MeetingRow | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);

  const mayCreate = can(permissions, "MEETINGS", "create", groupId || null);

  function close() {
    setEditing(null);
    mutation.reset();
  }

  function openCreate() {
    setDraft({ ...BLANK, groupId, meetingDate: toDateInput(new Date()) });
    setEditing("new");
    mutation.reset();
  }

  function openEdit(meeting: MeetingRow) {
    setDraft({
      title: meeting.title,
      meetingDate: toDateInput(meeting.meetingDate),
      groupId: meeting.groupId ?? "",
      body: meeting.body ?? "",
    });
    setEditing(meeting);
    mutation.reset();
  }

  async function submit() {
    const body = {
      title: draft.title,
      meetingDate: draft.meetingDate,
      groupId: selectToNull(draft.groupId),
      body: emptyToNull(draft.body),
    };

    const ok = await mutation.run(() =>
      editing === "new"
        ? apiClient.post("/meetings", body)
        : apiClient.patch(`/meetings/${(editing as MeetingRow).id}`, body)
    );
    if (ok) {
      close();
      meetings.reload();
    }
  }

  async function remove(id: string) {
    if (await mutation.run(() => apiClient.delete(`/meetings/${id}`))) meetings.reload();
  }

  return (
    <>
      <PageHeader title="Toplantilar">
        <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          <option value="">Tum toplantilar</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        {mayCreate ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
            + Yeni toplanti
          </button>
        ) : null}
      </PageHeader>

      {editing ? (
        <FormPanel
          title={editing === "new" ? "Yeni toplanti" : "Toplantiyi duzenle"}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submit}
          onCancel={close}
        >
          <TextField
            label="Baslik"
            value={draft.title}
            required
            onChange={(title) => setDraft({ ...draft, title })}
            error={issueFor(mutation.error, "title")}
          />
          <div className="row">
            <TextField
              label="Tarih"
              type="date"
              value={draft.meetingDate}
              required
              onChange={(meetingDate) => setDraft({ ...draft, meetingDate })}
              error={issueFor(mutation.error, "meetingDate")}
            />
            <SelectField
              label="Grup"
              value={draft.groupId}
              placeholder="Takim geneli"
              options={groups.map((group) => ({ value: group.id, label: group.name }))}
              onChange={(value) => setDraft({ ...draft, groupId: value })}
              error={issueFor(mutation.error, "groupId")}
            />
          </div>
          <TextAreaField
            label="Rapor"
            rows={6}
            value={draft.body}
            onChange={(value) => setDraft({ ...draft, body: value })}
            error={issueFor(mutation.error, "body")}
          />
        </FormPanel>
      ) : null}

      {!editing && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={meetings}>
        {(data) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Baslik</th>
                  <th>Tarih</th>
                  <th>Grup</th>
                  <th className="numeric">Katilim</th>
                  <th>Olusturan</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((meeting) => (
                  <tr key={meeting.id}>
                    <td>
                      <Link href={`/meetings/${meeting.id}`}>{meeting.title}</Link>
                    </td>
                    <td>{formatDate(meeting.meetingDate)}</td>
                    <td>{meeting.groupName ?? <span className="muted">Takim geneli</span>}</td>
                    <td className="numeric">
                      {meeting.attendedCount} / {meeting.attendance.length}
                    </td>
                    <td className="muted">{meeting.createdBy.fullName}</td>
                    <td>
                      <RowActions>
                        {can(permissions, "MEETINGS", "update", meeting.groupId) ? (
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => openEdit(meeting)}
                          >
                            Duzenle
                          </button>
                        ) : null}
                        {can(permissions, "MEETINGS", "delete", meeting.groupId) ? (
                          <ConfirmButton
                            question={`${meeting.title} silinsin mi? Yoklamasi da silinir.`}
                            onConfirm={() => void remove(meeting.id)}
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
        )}
      </AsyncSection>
    </>
  );
}
