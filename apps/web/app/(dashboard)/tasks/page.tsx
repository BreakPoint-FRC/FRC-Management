"use client";

import Link from "next/link";
import { useState } from "react";
import {
  taskPriorityLabels,
  taskStatusLabels,
  type Paginated,
} from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import {
  AsyncSection,
  Badge,
  ConfirmButton,
  ErrorBox,
  PageHeader,
  RowActions,
} from "@/components/ui";
import {
  FormPanel,
  SelectField,
  TextAreaField,
  TextField,
  optionsFrom,
} from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { TaskRow } from "@/lib/api-types";
import { emptyToNull, emptyToUndefined, selectToNull } from "@/lib/form-helpers";
import { formatDate, toDateInput } from "@/lib/format";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";
import { taskStatusTone } from "@/lib/status";

interface Draft {
  name: string;
  description: string;
  groupId: string;
  status: string;
  priority: string;
  startDate: string;
  dueDate: string;
}

const BLANK: Draft = {
  name: "",
  description: "",
  groupId: "",
  status: "TODO",
  priority: "MEDIUM",
  startDate: "",
  dueDate: "",
};

export default function TasksPage() {
  const { groups = [], permissions } = useAuth();
  const [groupId, setGroupId] = useState("");
  const [status, setStatus] = useState("");
  const [openOnly, setOpenOnly] = useState(false);

  const params = new URLSearchParams({ pageSize: "100" });
  if (groupId) params.set("groupId", groupId);
  if (status) params.set("status", status);
  if (openOnly) params.set("open", "true");

  const tasks = useApi<Paginated<TaskRow>>(`/tasks?${params.toString()}`);
  const mutation = useMutation();

  const [editing, setEditing] = useState<TaskRow | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);

  const groupOptions = groups.map((group) => ({ value: group.id, label: group.name }));

  function close() {
    setEditing(null);
    mutation.reset();
  }

  function openCreate() {
    // Defaults to the filtered group, which is almost always the one meant.
    setDraft({ ...BLANK, groupId });
    setEditing("new");
    mutation.reset();
  }

  function openEdit(task: TaskRow) {
    setDraft({
      name: task.name,
      description: task.description ?? "",
      groupId: task.groupId ?? "",
      status: task.status,
      priority: task.priority,
      startDate: toDateInput(task.startDate),
      dueDate: toDateInput(task.dueDate),
    });
    setEditing(task);
    mutation.reset();
  }

  async function submit() {
    const body = {
      name: draft.name,
      description: emptyToNull(draft.description),
      groupId: selectToNull(draft.groupId),
      status: draft.status,
      priority: draft.priority,
      startDate: emptyToUndefined(draft.startDate) ?? null,
      dueDate: emptyToUndefined(draft.dueDate) ?? null,
    };

    const ok = await mutation.run(() =>
      editing === "new"
        ? apiClient.post("/tasks", body)
        : apiClient.patch(`/tasks/${(editing as TaskRow).id}`, body)
    );
    if (ok) {
      close();
      tasks.reload();
    }
  }

  async function remove(id: string) {
    if (await mutation.run(() => apiClient.delete(`/tasks/${id}`))) tasks.reload();
  }

  // Creating is authorized against the group the form is aiming at; there is no
  // stored row yet, so the draft is the only thing to check.
  const mayCreate = can(permissions, "TASKS", "create", groupId || null);

  return (
    <>
      <PageHeader title="Gorevler">
        <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          <option value="">Tum gruplar</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>

        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Tum durumlar</option>
          {Object.entries(taskStatusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        <label className="row small">
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(event) => setOpenOnly(event.target.checked)}
          />
          Sadece acik olanlar
        </label>

        {mayCreate ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
            + Yeni gorev
          </button>
        ) : null}
      </PageHeader>

      <p className="small muted">
        Yapilacaklar listesi ayri bir tablo degil, bu tablonun filtrelenmis halidir: &quot;sadece
        acik olanlar&quot; tamamlanmamis ve iptal edilmemis gorevleri gosterir. Ayni is iki yerde
        tutulmadigi icin ikisi birbiriyle celisemez.
      </p>

      {editing ? (
        <FormPanel
          title={editing === "new" ? "Yeni gorev" : "Gorevi duzenle"}
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
            value={draft.description}
            onChange={(description) => setDraft({ ...draft, description })}
            error={issueFor(mutation.error, "description")}
          />
          <div className="row">
            <SelectField
              label="Grup"
              value={draft.groupId}
              placeholder="Gruplar arasi"
              hint="Bos birakilirsa takim geneli bir gorev olur."
              options={groupOptions}
              onChange={(value) => setDraft({ ...draft, groupId: value })}
              error={issueFor(mutation.error, "groupId")}
            />
            <SelectField
              label="Durum"
              value={draft.status}
              options={optionsFrom(taskStatusLabels)}
              onChange={(value) => setDraft({ ...draft, status: value })}
              error={issueFor(mutation.error, "status")}
            />
            <SelectField
              label="Oncelik"
              value={draft.priority}
              options={optionsFrom(taskPriorityLabels)}
              onChange={(value) => setDraft({ ...draft, priority: value })}
              error={issueFor(mutation.error, "priority")}
            />
          </div>
          <div className="row">
            <TextField
              label="Baslangic"
              type="date"
              value={draft.startDate}
              onChange={(startDate) => setDraft({ ...draft, startDate })}
              error={issueFor(mutation.error, "startDate")}
            />
            <TextField
              label="Bitis"
              type="date"
              value={draft.dueDate}
              onChange={(dueDate) => setDraft({ ...draft, dueDate })}
              error={issueFor(mutation.error, "dueDate")}
            />
          </div>
        </FormPanel>
      ) : null}

      {!editing && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={tasks} empty="Bu filtrelerle gorev yok.">
        {(data) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Gorev</th>
                  <th>Grup</th>
                  <th>Durum</th>
                  <th>Oncelik</th>
                  <th>Sorumlular</th>
                  <th>Bitis</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <Link href={`/tasks/${task.id}`}>{task.name}</Link>
                    </td>
                    <td>{task.groupName ?? <span className="muted">Gruplar arasi</span>}</td>
                    <td>
                      <Badge tone={taskStatusTone[task.status]}>
                        {taskStatusLabels[task.status]}
                      </Badge>
                    </td>
                    <td>{taskPriorityLabels[task.priority]}</td>
                    <td>
                      {task.assignees.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        task.assignees.map((assignee) => assignee.fullName).join(", ")
                      )}
                    </td>
                    <td>{formatDate(task.dueDate)}</td>
                    <td>
                      <RowActions>
                        {/* Authorized against the group the task is in, read
                            from the stored row rather than any form state. */}
                        {can(permissions, "TASKS", "update", task.groupId) ? (
                          <button className="btn btn-sm" type="button" onClick={() => openEdit(task)}>
                            Duzenle
                          </button>
                        ) : null}
                        {can(permissions, "TASKS", "delete", task.groupId) ? (
                          <ConfirmButton
                            question={`${task.name} silinsin mi? Gecmisi de silinir.`}
                            onConfirm={() => void remove(task.id)}
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
