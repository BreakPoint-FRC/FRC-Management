"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
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
  CheckboxField,
  FormPanel,
  SelectField,
  TextAreaField,
  TextField,
  optionsFrom,
} from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { AccountRow, TaskRow } from "@/lib/api-types";
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
  // "Tüm gruplar" (no groupId) is an unscoped request, and authorize() only
  // lets a TEAM_WIDE/EXTERNAL role make one -- a department lead with no
  // team-wide TASKS grant would 403 on load with that as the default. Such an
  // account's own group memberships are exactly the departments it runs, so
  // the first one is a default that actually resolves; team-wide readers keep
  // "Tüm gruplar" since it works for them.
  const mayReadTasksGlobally = can(permissions, "TASKS", "read");
  const [groupId, setGroupId] = useState(() => (mayReadTasksGlobally ? "" : (groups[0]?.id ?? "")));
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [openOnly, setOpenOnly] = useState(false);
  // Off by default on a phone: see the filter-bar note below. On a wider
  // screen the CSS forces the panel open regardless of this flag.
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Who a task can be assigned to, for the "Sorumlu" filter -- the same
  // roster GET /accounts already serves. A team-wide ACCOUNTS reader can
  // fetch it unscoped or narrowed to whichever group is picked; a reader
  // whose ACCOUNTS grant is per-group (a department lead with no team-wide
  // role, say) can only fetch it once a specific department is picked --
  // canAnywhere alone would say yes and then ask GET /accounts with no
  // groupId, which is exactly the request such an account gets a 403 from.
  // The filter itself is hidden rather than shown disabled in that case, so
  // there is nothing on screen that does not work.
  const mayReadAccountsGlobally = can(permissions, "ACCOUNTS", "read");
  const mayReadAccountsInGroup = groupId ? can(permissions, "ACCOUNTS", "read", groupId) : false;
  const mayReadAccounts = mayReadAccountsGlobally || mayReadAccountsInGroup;
  const candidates = useApi<Paginated<AccountRow>>(
    mayReadAccounts
      ? `/accounts?pageSize=100${groupId ? `&groupId=${encodeURIComponent(groupId)}` : ""}`
      : null
  );

  const params = new URLSearchParams({ pageSize: "100" });
  if (groupId) params.set("groupId", groupId);
  if (status) params.set("status", status);
  if (priority) params.set("priority", priority);
  // Dropped along with the filter once its roster is no longer readable,
  // rather than silently going on filtering by an assignee the account can
  // no longer see or choose.
  if (assigneeId && mayReadAccounts) params.set("assigneeId", assigneeId);
  if (openOnly) params.set("open", "true");

  const tasks = useApi<Paginated<TaskRow>>(`/tasks?${params.toString()}`);
  const mutation = useMutation();

  // due date has no server-side range filter (tasks.schema.ts has none to
  // add without widening the API for one screen) -- the page already fetches
  // its whole, bounded page of matching rows, so narrowing it further by date
  // is exact and does not cost a second round trip.
  const items = useMemo(() => {
    const rows = tasks.data?.items ?? [];
    const dueFromDate = dueFrom ? new Date(dueFrom) : null;
    const dueToDate = dueTo ? new Date(dueTo) : null;
    if (!dueFromDate && !dueToDate) return rows;
    return rows.filter((task) => {
      if (task.dueDate === null) return false;
      const due = new Date(task.dueDate);
      if (dueFromDate && due < dueFromDate) return false;
      if (dueToDate && due > dueToDate) return false;
      return true;
    });
  }, [tasks.data, dueFrom, dueTo]);

  const [editing, setEditing] = useState<TaskRow | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);

  const groupOptions = groups.map((group) => ({ value: group.id, label: group.name }));
  const assigneeOptions = (candidates.data?.items ?? []).map((account) => ({
    value: account.id,
    label: account.fullName,
  }));

  const activeFilterCount = [groupId, status, priority, assigneeId, dueFrom, dueTo, openOnly ? "1" : ""].filter(
    Boolean
  ).length;

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

    const ok = await mutation.run(
      () =>
        editing === "new"
          ? apiClient.post("/tasks", body)
          : apiClient.patch(`/tasks/${(editing as TaskRow).id}`, body),
      editing === "new" ? "Görev oluşturuldu." : "Görev güncellendi."
    );
    if (ok) {
      close();
      tasks.reload();
    }
  }

  async function remove(id: string) {
    if (await mutation.run(() => apiClient.delete(`/tasks/${id}`), "Görev silindi.")) tasks.reload();
  }

  // Creating is authorized against the group the form is aiming at; there is no
  // stored row yet, so the draft is the only thing to check.
  const mayCreate = can(permissions, "TASKS", "create", groupId || null);

  return (
    <>
      <PageHeader title="Görevler">
        {mayCreate ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
            <Plus size={14} aria-hidden="true" />
            Yeni görev
          </button>
        ) : null}
      </PageHeader>

      <div className="filter-bar">
        <button
          type="button"
          className="btn btn-sm filters-toggle"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((value) => !value)}
        >
          Filtreler{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
        </button>

        <div className={`filter-panel${filtersOpen ? " is-open" : ""}`}>
          <SelectField
            label="Grup"
            value={groupId}
            placeholder="Tüm gruplar"
            options={groupOptions}
            onChange={setGroupId}
          />
          <SelectField
            label="Durum"
            value={status}
            placeholder="Tüm durumlar"
            options={optionsFrom(taskStatusLabels)}
            onChange={setStatus}
          />
          <SelectField
            label="Öncelik"
            value={priority}
            placeholder="Tüm öncelikler"
            options={optionsFrom(taskPriorityLabels)}
            onChange={setPriority}
          />
          {mayReadAccounts ? (
            <SelectField
              label="Sorumlu"
              value={assigneeId}
              placeholder="Herkes"
              options={assigneeOptions}
              onChange={setAssigneeId}
            />
          ) : null}
          <TextField label="Bitiş başlangıcı" type="date" value={dueFrom} onChange={setDueFrom} />
          <TextField label="Bitiş sonu" type="date" value={dueTo} onChange={setDueTo} />
          <CheckboxField label="Sadece açık olanlar" checked={openOnly} onChange={setOpenOnly} />
        </div>
      </div>

      <p className="small muted">
        Yapılacaklar listesi ayrı bir tablo değil, bu tablonun filtrelenmiş halidir: &quot;sadece
        açık olanlar&quot; tamamlanmamış ve iptal edilmemiş görevleri gösterir. Aynı iş iki yerde
        tutulmadığı için ikisi birbiriyle çelişemez.
      </p>

      {editing ? (
        <FormPanel
          title={editing === "new" ? "Yeni görev" : "Görevi düzenle"}
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
            label="Açıklama"
            value={draft.description}
            onChange={(description) => setDraft({ ...draft, description })}
            error={issueFor(mutation.error, "description")}
          />
          <div className="row">
            <SelectField
              label="Grup"
              value={draft.groupId}
              placeholder="Gruplar arası"
              hint="Boş bırakılırsa takım geneli bir görev olur."
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
              label="Öncelik"
              value={draft.priority}
              options={optionsFrom(taskPriorityLabels)}
              onChange={(value) => setDraft({ ...draft, priority: value })}
              error={issueFor(mutation.error, "priority")}
            />
          </div>
          <div className="row">
            <TextField
              label="Başlangıç"
              type="date"
              value={draft.startDate}
              onChange={(startDate) => setDraft({ ...draft, startDate })}
              error={issueFor(mutation.error, "startDate")}
            />
            <TextField
              label="Bitiş"
              type="date"
              value={draft.dueDate}
              onChange={(dueDate) => setDraft({ ...draft, dueDate })}
              error={issueFor(mutation.error, "dueDate")}
            />
          </div>
        </FormPanel>
      ) : null}

      {!editing && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={tasks} empty="Bu filtrelerle görev yok." isEmpty={() => items.length === 0}>
        {() =>
          (
            <div className="table-wrap table-responsive-wrap">
              <table className="table table-responsive">
                <thead>
                  <tr>
                    <th>Görev</th>
                    <th>Grup</th>
                    <th>Durum</th>
                    <th>Öncelik</th>
                    <th>Sorumlular</th>
                    <th>Bitiş</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((task) => (
                    <tr key={task.id}>
                      <td data-label="Görev">
                        <Link href={`/tasks/${task.id}`}>{task.name}</Link>
                      </td>
                      <td data-label="Grup">
                        {task.groupName ?? <span className="muted">Gruplar arası</span>}
                      </td>
                      <td data-label="Durum">
                        <Badge tone={taskStatusTone[task.status]}>
                          {taskStatusLabels[task.status]}
                        </Badge>
                      </td>
                      <td data-label="Öncelik">{taskPriorityLabels[task.priority]}</td>
                      <td data-label="Sorumlular">
                        {task.assignees.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          task.assignees.map((assignee) => assignee.fullName).join(", ")
                        )}
                      </td>
                      <td data-label="Bitiş">{formatDate(task.dueDate)}</td>
                      <td>
                        <RowActions>
                          {/* Authorized against the group the task is in, read
                              from the stored row rather than any form state. */}
                          {can(permissions, "TASKS", "update", task.groupId) ? (
                            <button className="btn btn-sm" type="button" onClick={() => openEdit(task)}>
                              <Pencil size={14} aria-hidden="true" />
                              Düzenle
                            </button>
                          ) : null}
                          {can(permissions, "TASKS", "delete", task.groupId) ? (
                            <ConfirmButton
                              question={`${task.name} silinsin mi? Geçmişi de silinir.`}
                              onConfirm={() => remove(task.id)}
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
          )
        }
      </AsyncSection>
    </>
  );
}
