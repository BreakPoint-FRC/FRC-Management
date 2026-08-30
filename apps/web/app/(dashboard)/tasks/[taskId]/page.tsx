"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  taskActivityLabels,
  taskPriorityLabels,
  taskStatusLabels,
  type Paginated,
  type TaskStatus,
} from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import { AsyncSection, Badge, Card, ErrorBox, PageHeader } from "@/components/ui";
import { CheckboxField, FormPanel } from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { ApiError, apiClient } from "@/lib/api-client";
import { formatDate, formatDateTime } from "@/lib/format";
import { can } from "@/lib/permissions";
import type { AccountRow, TaskActivityRow, TaskRow } from "@/lib/api-types";
import { taskStatusTone } from "@/lib/status";

function describe(entry: TaskActivityRow): string {
  const from = entry.oldValue ? Object.values(entry.oldValue).join(", ") : null;
  const to = entry.newValue ? Object.values(entry.newValue).join(", ") : null;

  if (from && to) return `${from} → ${to}`;
  return to ?? from ?? "";
}

export default function TaskDetailPage({ params }: { params: { taskId: string } }) {
  const { permissions } = useAuth();
  const task = useApi<TaskRow>(`/tasks/${params.taskId}`);
  const activity = useApi<Paginated<TaskActivityRow>>(`/tasks/${params.taskId}/activity?pageSize=50`);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  // Candidates come from the group the task is in; a cross-group task can be
  // assigned to anyone.
  const [editingAssignees, setEditingAssignees] = useState(false);
  const [assignees, setAssignees] = useState<Set<string>>(new Set());
  const candidates = useApi<Paginated<AccountRow>>(
    editingAssignees
      ? task.data?.groupId
        ? `/accounts?groupId=${encodeURIComponent(task.data.groupId)}&pageSize=200`
        : "/accounts?pageSize=200"
      : null
  );

  useEffect(() => {
    if (!task.data) return;
    setAssignees(new Set(task.data.assignees.map((entry) => entry.accountId)));
  }, [task.data]);

  async function saveAssignees() {
    setSaving(true);
    setSaveError(null);

    try {
      // Whole set, like every other assignment here: anyone left out is removed,
      // and the activity log records each addition and removal by name.
      await apiClient.put(`/tasks/${params.taskId}/assignees`, { accountIds: [...assignees] });
      setEditingAssignees(false);
      task.reload();
      activity.reload();
    } catch (cause) {
      setSaveError(
        cause instanceof ApiError ? cause : new ApiError(0, "Beklenmeyen bir hata olustu")
      );
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(status: TaskStatus) {
    setSaving(true);
    setSaveError(null);

    try {
      await apiClient.patch(`/tasks/${params.taskId}`, { status });
      task.reload();
      // The log is written in the same transaction as the change, so it always
      // has the new entry by the time this runs.
      activity.reload();
    } catch (cause) {
      setSaveError(
        cause instanceof ApiError ? cause : new ApiError(0, "Beklenmeyen bir hata olustu")
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <AsyncSection state={task}>
      {(data) => {
        // Authorized against the group the task is *in*, which is what the
        // server does too. A cross-group task (no group) needs a team-wide role.
        const mayUpdate = can(permissions, "TASKS", "update", data.groupId);

        return (
          <>
            <PageHeader title={data.name}>
              <Link className="btn btn-sm" href="/tasks">
                Listeye don
              </Link>
            </PageHeader>

            <div className="stack">
              {saveError ? <ErrorBox error={saveError} /> : null}

              <div className="grid">
                <Card title="Durum">
                  {mayUpdate ? (
                    <select
                      value={data.status}
                      disabled={saving}
                      onChange={(event) => void changeStatus(event.target.value as TaskStatus)}
                    >
                      {Object.entries(taskStatusLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    // Read-only rather than a disabled control: an account that
                    // cannot change this does not need to be shown a dropdown.
                    <Badge tone={taskStatusTone[data.status]}>{taskStatusLabels[data.status]}</Badge>
                  )}
                </Card>

                <Card title="Oncelik">
                  <div className="stat" style={{ fontSize: 16 }}>
                    {taskPriorityLabels[data.priority]}
                  </div>
                </Card>

                <Card title="Grup">
                  <div className="stat" style={{ fontSize: 16 }}>
                    {data.groupName ?? "Gruplar arasi"}
                  </div>
                </Card>

                <Card title="Tarihler">
                  <div className="small">
                    <div>Baslangic: {formatDate(data.startDate)}</div>
                    <div>Bitis: {formatDate(data.dueDate)}</div>
                  </div>
                </Card>
              </div>

              <Card title="Aciklama">
                <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                  {data.description ?? <span className="muted">Aciklama yok.</span>}
                </p>
              </Card>

              {editingAssignees ? (
                <FormPanel
                  title="Sorumlular"
                  error={saveError}
                  saving={saving}
                  onSubmit={() => void saveAssignees()}
                  onCancel={() => setEditingAssignees(false)}
                >
                  <AsyncSection state={candidates}>
                    {(people) => (
                      <div className="stack-sm">
                        {people.items.map((person) => (
                          <CheckboxField
                            key={person.id}
                            label={person.fullName}
                            checked={assignees.has(person.id)}
                            onChange={(checked) =>
                              setAssignees((current) => {
                                const next = new Set(current);
                                if (checked) next.add(person.id);
                                else next.delete(person.id);
                                return next;
                              })
                            }
                          />
                        ))}
                      </div>
                    )}
                  </AsyncSection>
                </FormPanel>
              ) : (
                <Card title="Sorumlular">
                  {data.assignees.length === 0 ? (
                    <span className="muted">Kimse atanmamis.</span>
                  ) : (
                    <div className="row">
                      {data.assignees.map((assignee) => (
                        <Badge key={assignee.accountId}>{assignee.fullName}</Badge>
                      ))}
                    </div>
                  )}
                  <p className="small muted" style={{ marginBottom: 0 }}>
                    Bir goreve birden fazla kisi atanabilir. Olusturan: {data.createdBy.fullName}
                  </p>
                  {mayUpdate ? (
                    <button
                      className="btn btn-sm"
                      type="button"
                      style={{ marginTop: 8 }}
                      onClick={() => setEditingAssignees(true)}
                    >
                      Sorumlulari duzenle
                    </button>
                  ) : null}
                </Card>
              )}

              <div>
                <h2>Gecmis</h2>
                <p className="small muted" style={{ marginTop: 0 }}>
                  Her kayit, anlattigi degisiklikle ayni islemde yazilir. Gorevin kaydi olmadan
                  degismesi mumkun degildir.
                </p>
                <AsyncSection state={activity} empty="Henuz kayit yok.">
                  {(log) => (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Ne oldu</th>
                            <th>Degisiklik</th>
                            <th>Kim</th>
                            <th>Ne zaman</th>
                          </tr>
                        </thead>
                        <tbody>
                          {log.items.map((entry) => (
                            <tr key={entry.id}>
                              <td>{taskActivityLabels[entry.action]}</td>
                              <td className="muted small">{describe(entry)}</td>
                              <td>{entry.actor?.fullName ?? <span className="muted">—</span>}</td>
                              <td className="small">{formatDateTime(entry.createdAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </AsyncSection>
              </div>
            </div>
          </>
        );
      }}
    </AsyncSection>
  );
}
