"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { attendanceStatusLabels, type AttendanceStatus } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import { AsyncSection, Badge, Card, ErrorBox, PageHeader } from "@/components/ui";
import { useApi } from "@/hooks/use-api";
import { ApiError, apiClient } from "@/lib/api-client";
import { formatDate } from "@/lib/format";
import { can } from "@/lib/permissions";
import type { MeetingRow } from "@/lib/api-types";
import { attendanceTone } from "@/lib/status";

export default function MeetingDetailPage({ params }: { params: { meetingId: string } }) {
  const { permissions } = useAuth();
  const meeting = useApi<MeetingRow>(`/meetings/${params.meetingId}`);

  const [draft, setDraft] = useState<Record<string, AttendanceStatus>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  // The roll call is edited as a whole set, so the form starts from what is
  // stored and sends all of it back -- the same shape the endpoint expects.
  // Anyone left out of the payload is dropped, which is why the draft is seeded
  // from the stored list rather than built up from clicks.
  useEffect(() => {
    if (!meeting.data) return;
    setDraft(
      Object.fromEntries(meeting.data.attendance.map((entry) => [entry.accountId, entry.status]))
    );
  }, [meeting.data]);

  async function save() {
    if (!meeting.data) return;
    setSaving(true);
    setSaveError(null);

    try {
      await apiClient.put(`/meetings/${params.meetingId}/attendance`, {
        attendance: meeting.data.attendance.map((entry) => ({
          accountId: entry.accountId,
          status: draft[entry.accountId] ?? entry.status,
          note: entry.note,
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
        const mayUpdate = can(permissions, "MEETINGS", "update", data.groupId);

        return (
          <>
            <PageHeader title={data.title}>
              <Link className="btn btn-sm" href="/meetings">
                Listeye don
              </Link>
            </PageHeader>

            <div className="stack">
              {saveError ? <ErrorBox error={saveError} /> : null}

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
                      {data.attendance.map((entry) => (
                        <tr key={entry.accountId}>
                          <td>{entry.fullName}</td>
                          <td>
                            {mayUpdate ? (
                              <select
                                value={draft[entry.accountId] ?? entry.status}
                                disabled={saving}
                                onChange={(event) =>
                                  setDraft((current) => ({
                                    ...current,
                                    [entry.accountId]: event.target.value as AttendanceStatus,
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
                              <Badge tone={attendanceTone[entry.status]}>
                                {attendanceStatusLabels[entry.status]}
                              </Badge>
                            )}
                          </td>
                          <td className="muted small">{entry.note ?? "—"}</td>
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
                    disabled={saving}
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
