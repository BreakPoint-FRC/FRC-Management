"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { calendarEntryKindLabels, type CalendarEntryKind } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import { AsyncSection, PageHeader } from "@/components/ui";
import { useApi } from "@/hooks/use-api";
import type { CalendarEntryRow, CalendarRangeRow } from "@/lib/api-types";
import {
  WEEKDAY_LABELS,
  addMonths,
  dayKey,
  isSameMonth,
  monthGrid,
  startOfMonth,
} from "@/lib/calendar-grid";
import { formatDate, monthLabel } from "@/lib/format";
import { can } from "@/lib/permissions";

/** Which link a cell entry leads to. The calendar owns no records of its own. */
const HREF: Record<CalendarEntryKind, (id: string) => string> = {
  MEETING: (id) => `/meetings/${id}`,
  TASK_START: (id) => `/tasks/${id}`,
  TASK_DUE: (id) => `/tasks/${id}`,
};

const CLASS: Record<CalendarEntryKind, string> = {
  MEETING: "kind-meeting",
  TASK_START: "kind-task-start",
  TASK_DUE: "kind-task-due",
};

/** The prefix in front of a task title, so a stripe colour is never the only
    thing saying which end of the task this is. */
const PREFIX: Record<CalendarEntryKind, string> = {
  MEETING: "",
  TASK_START: "Baslar: ",
  TASK_DUE: "Biter: ",
};

export default function CalendarPage() {
  const { groups = [], permissions } = useAuth();

  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));

  // Same rule as the Gantt page: reading the whole team's calendar is a
  // team-wide permission, so a lead who only holds CALENDAR in their own group
  // has to start there or the first request is a 403.
  const [groupFilter, setGroupFilter] = useState(() =>
    can(permissions, "CALENDAR", "read") ? "" : (groups[0]?.id ?? "")
  );

  const [show, setShow] = useState({ meetings: true, tasks: true, season: true });

  const grid = useMemo(() => monthGrid(cursor), [cursor]);

  // The window is the grid, not the month: the padding days show real entries,
  // so the neighbouring months' edges have to be fetched with it.
  const from = grid[0] as Date;
  const to = grid[grid.length - 1] as Date;

  const params = new URLSearchParams({ from: dayKey(from), to: dayKey(to) });
  if (groupFilter) params.set("groupId", groupFilter);

  const calendar = useApi<CalendarRangeRow>(`/calendar?${params.toString()}`);

  const today = dayKey(new Date());

  return (
    <>
      <PageHeader title="Takvim">
        <button className="btn btn-sm" type="button" onClick={() => setCursor(addMonths(cursor, -1))}>
          ‹
        </button>
        <strong>{monthLabel(cursor, true)}</strong>
        <button className="btn btn-sm" type="button" onClick={() => setCursor(addMonths(cursor, 1))}>
          ›
        </button>
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => setCursor(startOfMonth(new Date()))}
        >
          Bugun
        </button>
        <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
          {can(permissions, "CALENDAR", "read") ? <option value="">Tum takim</option> : null}
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </PageHeader>

      <div className="row">
        <label className="small">
          <input
            type="checkbox"
            checked={show.meetings}
            onChange={(event) => setShow({ ...show, meetings: event.target.checked })}
          />{" "}
          Toplantilar
        </label>
        <label className="small">
          <input
            type="checkbox"
            checked={show.tasks}
            onChange={(event) => setShow({ ...show, tasks: event.target.checked })}
          />{" "}
          Gorevler
        </label>
        <label className="small">
          <input
            type="checkbox"
            checked={show.season}
            onChange={(event) => setShow({ ...show, season: event.target.checked })}
          />{" "}
          Sezon disi gunler
        </label>
      </div>

      <p className="small muted">
        Takvim kendi kaydini tutmaz. Her giris bir toplantinin ya da bir gorevin kendi tarihinden
        cizilir — gorev sayfasinda tarihi degistirmek takvimi de degistirir. Yalnizca zaten
        gorebildiginiz kayitlar listelenir.
      </p>

      <AsyncSection state={calendar}>
        {(data) => {
          const entries = data.items.filter((entry) =>
            entry.kind === "MEETING" ? show.meetings : show.tasks
          );

          const byDay = new Map<string, CalendarEntryRow[]>();
          for (const entry of entries) {
            const key = dayKey(entry.date);
            const bucket = byDay.get(key);
            if (bucket) bucket.push(entry);
            else byDay.set(key, [entry]);
          }

          const seasonStart = data.season ? dayKey(data.season.startDate) : null;
          const seasonEnd = data.season ? dayKey(data.season.endDate) : null;

          return (
            <div>
              <div className="calendar-head">
                {WEEKDAY_LABELS.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>

              <div className="calendar-grid">
                {grid.map((day) => {
                  const key = dayKey(day);
                  const offSeason =
                    show.season &&
                    data.season !== null &&
                    (key < (seasonStart as string) || key > (seasonEnd as string));

                  const classes = [
                    "calendar-day",
                    isSameMonth(day, cursor) ? "" : "is-outside",
                    key === today ? "is-today" : "",
                    offSeason ? "is-off-season" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");

                  return (
                    <div key={key} className={classes}>
                      <span className="calendar-date">{day.getDate()}</span>

                      {key === seasonStart ? (
                        <span className="calendar-season">Sezon basi</span>
                      ) : null}
                      {key === seasonEnd ? (
                        <span className="calendar-season">Sezon sonu</span>
                      ) : null}

                      {(byDay.get(key) ?? []).map((entry) => (
                        <Link
                          key={`${entry.kind}-${entry.id}`}
                          className={`calendar-event ${CLASS[entry.kind]}`}
                          href={HREF[entry.kind](entry.id)}
                          title={`${calendarEntryKindLabels[entry.kind]} · ${entry.title}${
                            entry.groupName ? ` · ${entry.groupName}` : ""
                          } · ${formatDate(entry.date)}`}
                        >
                          {PREFIX[entry.kind]}
                          {entry.title}
                        </Link>
                      ))}
                    </div>
                  );
                })}
              </div>

              {data.season ? (
                <p className="small muted">
                  {data.season.name}: {formatDate(data.season.startDate)} —{" "}
                  {formatDate(data.season.endDate)}
                </p>
              ) : null}
            </div>
          );
        }}
      </AsyncSection>
    </>
  );
}
