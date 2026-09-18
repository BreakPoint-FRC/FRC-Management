"use client";

import { useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { attendanceStatusLabels, type Paginated } from "@breakpoint/types";

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
import { emptyToNull, selectToNull } from "@/lib/form-helpers";
import { formatDate, toDateInput } from "@/lib/format";
import { issueFor } from "@/lib/issues";
import { can, canAnywhere } from "@/lib/permissions";
import type { MeetingRow } from "@/lib/api-types";
import { attendanceTone } from "@/lib/status";
import { GuardedLink, useUnsavedChanges } from "@/components/unsaved-changes";
import { isMeetingDraftDirty, type MeetingDraft } from "@/lib/meeting-draft";

const BLANK: MeetingDraft = { title: "", meetingDate: "", groupId: "", body: "" };

export default function MeetingsPage() {
  const { account, groups = [], permissions } = useAuth();
  // "Tüm toplantılar" (no groupId) is an unscoped request, and authorize()
  // only lets a TEAM_WIDE/EXTERNAL role make one -- same trap as the Tasks
  // page (see its own note): a department lead with no team-wide MEETINGS
  // grant would 403 on load with that as the default. Their own group
  // memberships are exactly the departments they run, so the first one is a
  // default that actually resolves.
  const mayReadMeetingsGlobally = can(permissions, "MEETINGS", "read");
  const [groupId, setGroupId] = useState(() => (mayReadMeetingsGlobally ? "" : (groups[0]?.id ?? "")));

  const query = groupId ? `?groupId=${encodeURIComponent(groupId)}&pageSize=100` : "?pageSize=100";
  const meetings = useApi<Paginated<MeetingRow>>(`/meetings${query}`);
  const mutation = useMutation();

  const [editing, setEditing] = useState<MeetingRow | "new" | null>(null);
  const [draft, setDraft] = useState<MeetingDraft>(BLANK);
  const [baseline, setBaseline] = useState<MeetingDraft>(BLANK);
  const guard = useUnsavedChanges({
    dirty: editing !== null && isMeetingDraftDirty(draft, baseline),
    saving: mutation.saving,
    discard: close,
  });

  const mayCreate = can(permissions, "MEETINGS", "create", groupId || null);
  // Whoever can organize at least one meeting is worth telling that a past
  // one has no report yet -- the same audience the roadmap calls "kaptan
  // veya mentor", read from actual grants rather than a role's name.
  const mayOrganizeAnywhere = canAnywhere(permissions, "MEETINGS", "update");

  const { upcoming, past, missingReportCount } = useMemo(() => {
    const items = meetings.data?.items ?? [];
    const now = new Date();
    const upcomingRows = items
      .filter((meeting) => new Date(meeting.meetingDate) >= now)
      .sort((a, b) => new Date(a.meetingDate).getTime() - new Date(b.meetingDate).getTime());
    const pastRows = items
      .filter((meeting) => new Date(meeting.meetingDate) < now)
      .sort((a, b) => new Date(b.meetingDate).getTime() - new Date(a.meetingDate).getTime());
    return {
      upcoming: upcomingRows,
      past: pastRows,
      missingReportCount: pastRows.filter((meeting) => meeting.body === null).length,
    };
  }, [meetings.data]);

  function close() {
    guard.markClean();
    setEditing(null);
    mutation.reset();
  }

  function openCreate() {
    const next = { ...BLANK, groupId, meetingDate: toDateInput(new Date()) };
    setDraft(next);
    setBaseline({ ...next });
    setEditing("new");
    mutation.reset();
  }

  function openEdit(meeting: MeetingRow) {
    const next = {
      title: meeting.title,
      meetingDate: toDateInput(meeting.meetingDate),
      groupId: meeting.groupId ?? "",
      body: meeting.body ?? "",
    };
    setDraft(next);
    setBaseline({ ...next });
    setEditing(meeting);
    mutation.reset();
  }

  async function submit() {
    if (!editing || guard.isSaving()) return;
    guard.setSaving(true);
    const body = {
      title: draft.title,
      meetingDate: draft.meetingDate,
      groupId: selectToNull(draft.groupId),
      body: emptyToNull(draft.body),
    };

    const ok = await mutation.run(
      () =>
        editing === "new"
          ? apiClient.post("/meetings", body)
          : apiClient.patch(`/meetings/${(editing as MeetingRow).id}`, body),
      editing === "new" ? "Toplantı oluşturuldu." : "Toplantı güncellendi."
    );
    guard.setSaving(false);
    if (ok) {
      close();
      meetings.reload();
    }
  }

  async function remove(id: string) {
    if (await mutation.run(() => apiClient.delete(`/meetings/${id}`), "Toplantı silindi.")) {
      meetings.reload();
    }
  }

  return (
    <>
      <PageHeader title="Toplantılar">
        <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          <option value="">Tüm toplantılar</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        {mayCreate ? (
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={mutation.saving}
            onClick={() => guard.requestLeave(openCreate)}
          >
            <Plus size={14} aria-hidden="true" />
            Yeni toplantı
          </button>
        ) : null}
      </PageHeader>

      {editing ? (
        <FormPanel
          title={editing === "new" ? "Yeni toplantı" : "Toplantıyı düzenle"}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submit}
          onCancel={() => guard.requestLeave(close)}
          cancelLabel="İptal"
        >
          <fieldset className="meeting-fields stack-sm" disabled={mutation.saving}>
            <TextField
              label="Başlık"
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
                placeholder="Takım geneli"
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
          </fieldset>
        </FormPanel>
      ) : null}

      {!editing && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={meetings}>
        {() => (
          <div className="stack">
            {mayOrganizeAnywhere && missingReportCount > 0 ? (
              <div className="card">
                <p style={{ margin: 0 }}>
                  <Badge tone="warn">Dikkat</Badge>{" "}
                  {missingReportCount === 1
                    ? "1 geçmiş toplantının raporu yok."
                    : `${missingReportCount} geçmiş toplantının raporu yok.`}
                </p>
              </div>
            ) : null}

            <div>
              <h2 style={{ marginBottom: 8 }}>Yaklaşan</h2>
              <MeetingList
                meetings={upcoming}
                empty="Planlanmış toplantı yok."
                myAccountId={account?.id}
                permissions={permissions}
                saving={mutation.saving}
                onEdit={(meeting) => guard.requestLeave(() => openEdit(meeting))}
                onDelete={remove}
              />
            </div>

            <div>
              <h2 style={{ marginBottom: 8 }}>Geçmiş</h2>
              <MeetingList
                meetings={past}
                empty="Henüz geçmiş toplantı yok."
                myAccountId={account?.id}
                permissions={permissions}
                saving={mutation.saving}
                onEdit={(meeting) => guard.requestLeave(() => openEdit(meeting))}
                onDelete={remove}
              />
            </div>
          </div>
        )}
      </AsyncSection>
    </>
  );
}

function MeetingList({
  meetings,
  empty,
  myAccountId,
  permissions,
  saving,
  onEdit,
  onDelete,
}: {
  meetings: MeetingRow[];
  empty: string;
  myAccountId: string | undefined;
  permissions: ReturnType<typeof useAuth>["permissions"];
  saving: boolean;
  onEdit: (meeting: MeetingRow) => void;
  onDelete: (id: string) => void | Promise<unknown>;
}) {
  if (meetings.length === 0) return <p className="empty">{empty}</p>;

  return (
    <div className="stack-sm">
      {meetings.map((meeting) => {
        const mine = myAccountId ? meeting.attendance.find((entry) => entry.accountId === myAccountId) : undefined;

        return (
          <div key={meeting.id} className="card meeting-card">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <p className="card-title" style={{ margin: "0 0 2px", textTransform: "none", fontSize: 14 }}>
                  <GuardedLink href={`/meetings/${meeting.id}`}>{meeting.title}</GuardedLink>
                </p>
                <p className="small muted" style={{ margin: 0 }}>
                  {formatDate(meeting.meetingDate)} · {meeting.groupName ?? "Takım geneli"}
                </p>
              </div>
              <RowActions>
                {can(permissions, "MEETINGS", "update", meeting.groupId) ? (
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={saving}
                    onClick={() => onEdit(meeting)}
                  >
                    <Pencil size={14} aria-hidden="true" />
                    Düzenle
                  </button>
                ) : null}
                {can(permissions, "MEETINGS", "delete", meeting.groupId) ? (
                  <ConfirmButton
                    disabled={saving}
                    question={`${meeting.title} silinsin mi? Yoklaması da silinir.`}
                    onConfirm={() => onDelete(meeting.id)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Sil
                  </ConfirmButton>
                ) : null}
              </RowActions>
            </div>

            <div className="row small" style={{ marginTop: 8, gap: 12 }}>
              <span className="muted">
                Yoklama: {meeting.attendedCount} / {meeting.attendance.length}
              </span>
              <Badge tone={meeting.body !== null ? "ok" : "off"}>
                {meeting.body !== null ? "Rapor var" : "Rapor yok"}
              </Badge>
              {mine ? (
                <Badge tone={attendanceTone[mine.status]}>{attendanceStatusLabels[mine.status]}</Badge>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
