"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { Paginated } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import {
  AsyncSection,
  ConfirmButton,
  ErrorBox,
  Loading,
  PageHeader,
  RowActions,
} from "@/components/ui";
import { CheckboxField, FormPanel, SelectField, TextField } from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { GanttBoardRow, TaskRow } from "@/lib/api-types";
import { selectToNull } from "@/lib/form-helpers";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";

// Recharts is a few hundred kilobytes and this is an installable PWA, so the
// chart is fetched only by the people who open this page. ssr:false as well:
// ResponsiveContainer measures its parent, and on the server there is nothing
// to measure.
const GanttTimelineChart = dynamic(() => import("@/components/gantt/timeline-chart"), {
  ssr: false,
  loading: () => <Loading />,
});

/** The "no department" option. An empty string already means "no filter". */
const TEAM_WIDE = "none";

type Panel =
  | { kind: "closed" }
  | { kind: "form"; board: GanttBoardRow | null }
  | { kind: "tasks"; board: GanttBoardRow };

export default function GanttPage() {
  const { groups = [], permissions } = useAuth();
  const mutation = useMutation();

  /*
   * Which department's boards to show.
   *
   * The default is not "all". Listing every board is a team-wide read, and a
   * department lead's GANTT permission is scoped to their group -- so an
   * unfiltered request is a 403 for exactly the person most likely to open this
   * page. Starting them on their own group is what gives each team its own
   * timeline instead of an error.
   */
  const [groupFilter, setGroupFilter] = useState(() =>
    can(permissions, "GANTT", "read") ? "" : (groups[0]?.id ?? "")
  );

  // A team-wide board has no group to filter on, and the API has no way to ask
  // for "groupId is null". It does not need one: reading a board with no group
  // already requires a team-wide role, so anyone who can pick this option could
  // have made the unfiltered request anyway.
  const scoped = groupFilter !== "" && groupFilter !== TEAM_WIDE;
  const boards = useApi<Paginated<GanttBoardRow>>(
    `/gantt?pageSize=50${scoped ? `&groupId=${groupFilter}` : ""}`
  );

  const [panel, setPanel] = useState<Panel>({ kind: "closed" });
  const [draft, setDraft] = useState({ name: "", groupId: "" });
  const [ordered, setOrdered] = useState<string[]>([]);

  // Only tasks from the season the board belongs to are valid; the API refuses
  // the rest rather than quietly drawing last season onto this timeline. The
  // group is passed for the same reason as above -- an unfiltered task list is
  // a team-wide read that the board's own lead may not have.
  const candidates = useApi<Paginated<TaskRow>>(
    panel.kind === "tasks"
      ? `/tasks?pageSize=200${panel.board.groupId ? `&groupId=${panel.board.groupId}` : ""}`
      : null
  );

  const mayCreate = can(permissions, "GANTT", "create", scoped ? groupFilter : null);

  function close() {
    setPanel({ kind: "closed" });
    mutation.reset();
  }

  function openForm(board: GanttBoardRow | null) {
    setDraft({
      name: board?.name ?? "",
      // Editing a board used to blank this, and submitForm turns "" into null:
      // renaming a department's board quietly moved it to the whole team. A new
      // board starts in whichever group is being looked at.
      groupId: board ? (board.groupId ?? "") : scoped ? groupFilter : "",
    });
    setPanel({ kind: "form", board });
    mutation.reset();
  }

  function openTasks(board: GanttBoardRow) {
    setOrdered(board.tasks.map((task) => task.id));
    setPanel({ kind: "tasks", board });
    mutation.reset();
  }

  function move(index: number, delta: number) {
    setOrdered((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;

      const next = [...current];
      [next[index], next[target]] = [next[target] as string, next[index] as string];
      return next;
    });
  }

  async function submitForm() {
    if (panel.kind !== "form") return;

    const body = { name: draft.name, groupId: selectToNull(draft.groupId) };
    const ok = await mutation.run(() =>
      panel.board
        ? apiClient.patch(`/gantt/${panel.board.id}`, body)
        : apiClient.post("/gantt", body)
    );
    if (ok) {
      close();
      boards.reload();
    }
  }

  // displayOrder comes from the array index rather than a number the client
  // picks: reordering is a new array, and letting the client choose the numbers
  // invites gaps, ties, and an off-by-one nobody can see.
  async function submitTasks() {
    if (panel.kind !== "tasks") return;

    const ok = await mutation.run(() =>
      apiClient.put(`/gantt/${panel.board.id}/tasks`, { taskIds: ordered })
    );
    if (ok) {
      close();
      boards.reload();
    }
  }

  async function remove(id: string) {
    if (await mutation.run(() => apiClient.delete(`/gantt/${id}`))) boards.reload();
  }

  return (
    <>
      <PageHeader title="Zaman cizelgesi">
        <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
          {/* Offered only when a team-wide read would actually succeed. */}
          {can(permissions, "GANTT", "read") ? <option value="">Tum panolar</option> : null}
          <option value={TEAM_WIDE}>Takim geneli</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        {mayCreate ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={() => openForm(null)}>
            + Yeni pano
          </button>
        ) : null}
      </PageHeader>

      <p className="small muted">
        Cubuklar gorevlerin kendi baslangic ve bitis tarihlerinden cizilir. Pano yalnizca hangi
        gorevin hangi sirada oldugunu tutar, tarih saklamaz — bu yuzden gorev sayfasinda tarihi
        degistirmek cizelgeyi de degistirir.
      </p>

      {panel.kind === "form" ? (
        <FormPanel
          title={panel.board ? "Panoyu duzenle" : "Yeni pano"}
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
          <SelectField
            label="Grup"
            value={draft.groupId}
            placeholder="Takim geneli"
            options={groups.map((group) => ({ value: group.id, label: group.name }))}
            onChange={(groupId) => setDraft({ ...draft, groupId })}
            error={issueFor(mutation.error, "groupId")}
          />
        </FormPanel>
      ) : null}

      {panel.kind === "tasks" ? (
        <FormPanel
          title={`${panel.board.name} — gorevler`}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submitTasks}
          onCancel={close}
        >
          <p className="small muted" style={{ margin: 0 }}>
            Sira, listedeki siradir. Listeden cikarilan gorev panodan cikar; gorevin kendisi
            silinmez.
          </p>

          <div className="stack-sm">
            {ordered.map((taskId, index) => {
              const task = panel.board.tasks.find((entry) => entry.id === taskId);
              return (
                <div key={taskId} className="row">
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    Yukari
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={index === ordered.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    Asagi
                  </button>
                  <span className="small">{task?.name ?? taskId}</span>
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={() => setOrdered((current) => current.filter((id) => id !== taskId))}
                  >
                    Cikar
                  </button>
                </div>
              );
            })}
          </div>

          <AsyncSection state={candidates}>
            {(data) => (
              <div className="stack-sm">
                <p className="card-title" style={{ margin: 0 }}>
                  Panoya ekle
                </p>
                {data.items
                  .filter((task) => !ordered.includes(task.id))
                  .map((task) => (
                    <CheckboxField
                      key={task.id}
                      label={`${task.name}${task.groupName ? ` · ${task.groupName}` : ""}`}
                      checked={false}
                      onChange={() => setOrdered((current) => [...current, task.id])}
                    />
                  ))}
              </div>
            )}
          </AsyncSection>
        </FormPanel>
      ) : null}

      {panel.kind === "closed" && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={boards} empty="Henuz pano olusturulmamis.">
        {(data) => {
          // "Takim geneli" is not a group the API can filter on, so it is
          // applied here -- see the comment on `scoped`.
          const visible =
            groupFilter === TEAM_WIDE
              ? data.items.filter((board) => board.groupId === null)
              : data.items;

          if (visible.length === 0) return <p className="empty">Bu grupta pano yok.</p>;

          return (
            <div className="stack">
              {groupBoards(visible).map(([groupName, boardsInGroup]) => (
                <section key={groupName}>
                  {/* One heading per department, but only when more than one
                      can be on screen -- a filtered list already says which. */}
                  {groupFilter === "" ? <h2 className="gantt-group">{groupName}</h2> : null}

                  <div className="stack">
                    {boardsInGroup.map((board) => (
                      <div key={board.id} className="card">
                        <div className="row" style={{ justifyContent: "space-between" }}>
                          <div>
                            <strong>{board.name}</strong>{" "}
                            <span className="small muted">
                              {board.seasonName}
                              {board.groupName ? ` · ${board.groupName}` : ""}
                            </span>
                          </div>
                          <RowActions>
                            <span className="small muted">{board.tasks.length} gorev</span>
                            {can(permissions, "GANTT", "update", board.groupId) ? (
                              <>
                                <button
                                  className="btn btn-sm"
                                  type="button"
                                  onClick={() => openTasks(board)}
                                >
                                  Gorevler
                                </button>
                                <button
                                  className="btn btn-sm"
                                  type="button"
                                  onClick={() => openForm(board)}
                                >
                                  Duzenle
                                </button>
                              </>
                            ) : null}
                            {can(permissions, "GANTT", "delete", board.groupId) ? (
                              <ConfirmButton
                                question={`${board.name} panosu silinsin mi? Gorevler silinmez.`}
                                onConfirm={() => void remove(board.id)}
                              >
                                Sil
                              </ConfirmButton>
                            ) : null}
                          </RowActions>
                        </div>

                        {board.tasks.length === 0 ? (
                          <p className="empty">Panoda gorev yok.</p>
                        ) : (
                          <GanttTimelineChart tasks={board.tasks} />
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          );
        }}
      </AsyncSection>
    </>
  );
}

/**
 * Boards by department, team-wide ones first.
 *
 * The API already sorts by name, so this only has to keep that order inside
 * each bucket -- which a Map does, being insertion-ordered over a sorted list.
 */
function groupBoards(boards: GanttBoardRow[]): Array<[string, GanttBoardRow[]]> {
  const TEAM_LABEL = "Takim geneli";
  const buckets = new Map<string, GanttBoardRow[]>();

  for (const board of boards) {
    const key = board.groupName ?? TEAM_LABEL;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(board);
    else buckets.set(key, [board]);
  }

  return [...buckets.entries()].sort(([a], [b]) => {
    if (a === TEAM_LABEL) return -1;
    if (b === TEAM_LABEL) return 1;
    return a.localeCompare(b, "tr");
  });
}
