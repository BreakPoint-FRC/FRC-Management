"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  attendanceStatusLabels,
  type AttendanceStatus,
  type Paginated,
} from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import { AsyncSection, Badge, Card, ErrorBox, PageHeader } from "@/components/ui";
import { useApi } from "@/hooks/use-api";
import { ApiError, apiClient } from "@/lib/api-client";
import { buildRollCall } from "@/lib/attendance";
import { formatDate } from "@/lib/format";
import { can } from "@/lib/permissions";
import type { AccountRow, MeetingRow } from "@/lib/api-types";
import { attendanceTone } from "@/lib/status";

export default function MeetingDetailPage({ params }: { params: { meetingId: string } }) {
  const { permissions } = useAuth();
  const meeting = useApi<MeetingRow>(`/meetings/${params.meetingId}`);

  // Decided here rather than inside the render callback because the roster
  // request below depends on it.
  const mayUpdate = meeting.data
    ? can(permissions, "MEETINGS", "update", meeting.data.groupId)
    : false;

  // Where a roll call that has not been taken yet gets its names from. A
  // meeting arrives with an empty attendance list -- nothing seeds one
  // server-side, and lib/attendance.ts says why -- so without this the page has
  // nothing to draw and attendance cannot be taken at all.
  //
  // The group's members for a group meeting; everyone on the team for a
  // team-wide one, because a team meeting is attended by the team and there is
  // no "member role" to filter on: roles are rows a team defines for itself.
  //
  // Only asked for when the viewer may actually take the roll call. Reading the
  // roster needs ACCOUNTS/read, which every role that can update a meeting
  // holds and a plain member does not -- asking anyway would turn their page
  // into an error box.
  const candidates = useApi<Paginated<AccountRow>>(
    !mayUpdate || !meeting.data
      ? null
      : meeting.data.groupId
        ? `/accounts?groupId=${encodeURIComponent(meeting.data.groupId)}&pageSize=100`
        : "/accounts?pageSize=100"
  );

  const [draft, setDraft] = useState<Record<string, AttendanceStatus>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  // Unsaved changes only. Cleared whenever the stored roll call is re-read, so
  // a row the user has not touched always shows what is on the record.
  useEffect(() => {
    setDraft({});
  }, [meeting.data]);

  const rows = buildRollCall(meeting.data?.attendance ?? [], candidates.data?.items ?? null);
  const rosterTruncated = candidates.data ? candidates.data.total > candidates.data.items.length : false;

  async function save() {
    setSaving(true);
    setSaveError(null);

    try {
      // The whole set, as the endpoint expects: anyone left out is deleted.
      // Sent from `rows` and not from the stored list, so that a member who has
      // never been marked is included -- and so that someone who has since left
      // the group keeps the attendance recorded against them.
      await apiClient.put(`/meetings/${params.meetingId}/attendance`, {
        attendance: rows.map((row) => ({
          accountId: row.accountId,
          status: draft[row.accountId] ?? row.status,
          note: row.note,
        })),
      });
      meeting.reload();
    } catch (cause) {
      setSaveError(
        cause instanceof ApiError ? cause : new ApiError(0, "Beklenmeyen bir hata olustu")
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <AsyncSection state={meeting}>
      {(data) => {
        return (
          <>
            <PageHeader title={data.title}>
              <Link className="btn btn-sm" href="/meetings">
                Listeye don
              </Link>
            </PageHeader>

            <div className="stack">
              {saveError ? <ErrorBox error={saveError} /> : null}
              {/* The roster failing is worth saying out loud: the stored roll
                  call still renders below, so the table would otherwise look
                  merely short rather than incomplete. */}
              {candidates.error ? <ErrorBox error={candidates.error} /> : null}

              <div className="row">
                <span className="muted">{formatDate(data.meetingDate)}</span>
                <Badge>{data.groupName ?? "Takim geneli"}</Badge>
                <span className="small muted">Olusturan: {data.createdBy.fullName}</span>
              </div>

              <Card title="Rapor">
                <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                  {data.body ?? <span className="muted">Rapor yazilmamis.</span>}
                </p>
              </Card>

              <div>
                <h2>Yoklama</h2>
                <p className="small muted" style={{ marginTop: 0 }}>
                  Dort durum var, cunku yoklamanin kaydettigi sey bir evet/hayir degil: gec
                  gelmek ve izinli olmak ayri seylerdir. Katilim oraninda gec gelen katilmis
                  sayilir.
                </p>

                {/* paginationSchema caps pageSize at 100, so a team with more
                    accounts than that gets a roster with names missing from it.
                    Nobody already on the roll call is lost -- the stored list is
                    merged in regardless -- but somebody who has never been
                    marked would be invisible, and a roll call that quietly
                    leaves people out is worse than one that says so. */}
                {rosterTruncated ? (
                  <p className="small muted">
                    Listede {candidates.data?.total} kisiden ilk{" "}
                    {candidates.data?.items.length} tanesi var. Kalanlar icin
                    yoklama bu ekrandan alinamiyor.
                  </p>
                ) : null}

                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Kisi</th>
                        <th>Durum</th>
                        <th>Not</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr>
                          <td className="muted" colSpan={3}>
                            {candidates.loading
                              ? "Uyeler yukleniyor..."
                              : mayUpdate
                                ? "Bu toplantiya katilabilecek kimse yok."
                                : "Yoklama alinmamis."}
                          </td>
                        </tr>
                      ) : null}
                      {rows.map((row) => (
                        <tr key={row.accountId}>
                          <td>
                            {row.fullName}
                            {/* Recorded here but no longer on the roster. Saving
                                keeps them -- the roll call is what happened,
                                not who is a member today. */}
                            {row.isFormerMember ? (
                              <span className="muted small"> (gruptan ayrildi)</span>
                            ) : null}
                          </td>
                          <td>
                            {mayUpdate ? (
                              <select
                                value={draft[row.accountId] ?? row.status}
                                disabled={saving}
                                onChange={(event) =>
                                  setDraft((current) => ({
                                    ...current,
                                    [row.accountId]: event.target.value as AttendanceStatus,
                                  }))
                                }
                              >
                                {Object.entries(attendanceStatusLabels).map(([value, label]) => (
                                  <option key={value} value={value}>
                                    {label}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <Badge tone={attendanceTone[row.status]}>
                                {attendanceStatusLabels[row.status]}
                              </Badge>
                            )}
                          </td>
                          <td className="muted small">{row.note ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {mayUpdate ? (
                  <button
                    className="btn btn-primary"
                    type="button"
                    style={{ marginTop: 12 }}
                    // Held until the roster has arrived: saving before it does
                    // would write a roll call missing everyone it was about to
                    // add, and the save replaces the whole set.
                    disabled={saving || candidates.loading}
                    onClick={() => void save()}
                  >
                    {saving ? "Kaydediliyor..." : "Yoklamayi kaydet"}
                  </button>
                ) : null}
              </div>
            </div>
          </>
        );
      }}
    </AsyncSection>
  );
}
