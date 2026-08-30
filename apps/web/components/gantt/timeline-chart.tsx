"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { taskStatusLabels } from "@breakpoint/types";

import type { GanttBoardTask } from "@/lib/api-types";
import { formatDate } from "@/lib/format";
import { taskStatusChartColor, toneChartColor } from "@/lib/status";

const DAY = 24 * 60 * 60 * 1000;

/** Y axis width. Roughly the label column the hand-rolled timeline used. */
const LABEL_WIDTH = 210;
const ROW_HEIGHT = 34;
const TICKS = 5;

interface Row {
  id: string;
  name: string;
  status: GanttBoardTask["status"];
  start: number;
  end: number;
  /** Milliseconds from the board's first day to this task's start. */
  offset: number;
  duration: number;
  days: number;
}

/**
 * The board's tasks as a timeline.
 *
 * Bars are positioned in milliseconds measured from the board's first day
 * rather than in absolute epoch time. That distinction matters: a bar chart's
 * numeric axis is anchored at zero, so absolute timestamps would stretch the
 * axis back to 1970 and squeeze every bar into the last pixel. Offsetting from
 * the board's own start puts zero where the board starts, which is where the
 * axis should begin anyway.
 *
 * The dates still come from the tasks, every time. A GanttTask row carries an
 * ordering and nothing else, so moving a due date on the task page moves the bar
 * here with no second record to keep in step.
 */
function toRow(task: GanttBoardTask, origin: number): Row | null {
  if (!task.startDate || !task.dueDate) return null;

  const start = new Date(task.startDate).getTime();
  const end = new Date(task.dueDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  // A task that starts and finishes on one day would otherwise be a zero-width
  // bar, which reads as "not scheduled" rather than "one day".
  const duration = Math.max(end - start, DAY);

  return {
    id: task.id,
    name: task.name,
    status: task.status,
    start,
    end,
    offset: start - origin,
    duration,
    days: Math.max(Math.round(duration / DAY), 1),
  };
}

export default function GanttTimelineChart({ tasks }: { tasks: GanttBoardTask[] }) {
  const dated = tasks.filter((task) => task.startDate && task.dueDate);
  const undated = tasks.filter((task) => !task.startDate || !task.dueDate);

  if (dated.length === 0) {
    return <p className="empty">Panodaki gorevlerin hicbirinde baslangic ve bitis tarihi yok.</p>;
  }

  const starts = dated.map((task) => new Date(task.startDate as string).getTime());
  const ends = dated.map((task) => new Date(task.dueDate as string).getTime());
  const origin = Math.min(...starts);
  // A board whose tasks all fall on one day would otherwise have no width.
  const span = Math.max(Math.max(...ends) - origin, DAY);

  const rows = dated
    .map((task) => toRow(task, origin))
    .filter((row): row is Row => row !== null);

  const today = Date.now() - origin;
  const height = rows.length * ROW_HEIGHT + 48;

  // Evenly spaced by hand: left to itself Recharts picks round millisecond
  // numbers, which are not round dates.
  const ticks = Array.from({ length: TICKS }, (_, i) => Math.round((span / (TICKS - 1)) * i));

  return (
    <div className="gantt-chart">
      {/*
        The bar colour is the task's status, and the status palette puts red
        beside green -- a pair a deuteranope cannot separate. So the status is
        written out too: once in this key, and again under every task's name.
      */}
      <div className="chart-key">
        <span>
          <i style={{ background: toneChartColor.ok }} /> Tamamlandi
        </span>
        <span>
          <i style={{ background: toneChartColor.warn }} /> Devam eden
        </span>
        <span>
          <i style={{ background: toneChartColor.danger }} /> Blokede
        </span>
        <span>
          <i style={{ background: toneChartColor.off }} /> Beklemede
        </span>
      </div>

      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
            barCategoryGap={6}
          >
            <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
            <XAxis
              type="number"
              domain={[0, span]}
              ticks={ticks}
              tickFormatter={(value: number) => formatDate(new Date(origin + value))}
              stroke="var(--chart-axis)"
              fontSize={11}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={LABEL_WIDTH}
              tickLine={false}
              interval={0}
              stroke="var(--chart-axis)"
              tick={(props: TickProps) => <TaskTick {...props} rows={rows} />}
            />
            {/*
              The first segment is the run-up from the board's first day to this
              task's start. It is stacked underneath the real bar and painted in
              nothing, which is what places the bar in time.
            */}
            <Bar dataKey="offset" stackId="span" fill="transparent" isAnimationActive={false} />
            <Bar dataKey="duration" stackId="span" radius={3} isAnimationActive={false}>
              {rows.map((row) => (
                <Cell key={row.id} fill={taskStatusChartColor(row.status)} />
              ))}
            </Bar>
            {/* Only worth drawing when today is actually on the board. */}
            {today >= 0 && today <= span ? (
              <ReferenceLine
                x={today}
                stroke="var(--accent)"
                strokeDasharray="3 3"
                label={{ value: "Bugun", position: "top", fill: "var(--accent)", fontSize: 11 }}
              />
            ) : null}
            <Tooltip
              cursor={{ fill: "var(--surface-2)", opacity: 0.5 }}
              content={<TimelineTooltip />}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {undated.length > 0 ? (
        <p className="small muted">
          Tarih girilmemis: {undated.map((task) => task.name).join(", ")}
        </p>
      ) : null}
    </div>
  );
}

// Recharts types a tick's coordinates as string | number, because an axis can
// be laid out either way. On this one they are always numbers.
interface TickProps {
  x?: string | number;
  y?: string | number;
  index?: number;
  payload?: { value?: string; index?: number };
}

/**
 * The row label: task name over its status, in words.
 *
 * A custom tick rather than the default string, because the status has to be
 * readable without the bar's colour and this is the only place it fits without
 * crowding the plot. The row is looked up by index -- the tick's payload only
 * carries the category value, and two tasks may share a name.
 */
function TaskTick({ x, y, index, payload, rows }: TickProps & { rows: Row[] }) {
  const position = payload?.index ?? index;
  const row = position === undefined ? undefined : rows[position];
  if (!row || x === undefined || y === undefined) return <g />;

  return (
    <g transform={`translate(${Number(x)},${Number(y)})`}>
      <text x={-8} y={-1} textAnchor="end" fill="var(--text)" fontSize={12}>
        {truncate(row.name)}
      </text>
      <text x={-8} y={12} textAnchor="end" fill="var(--chart-axis)" fontSize={10}>
        {taskStatusLabels[row.status]}
      </text>
    </g>
  );
}

/** Recharts gives the tick no width to work with, so the label is cut here. */
function truncate(name: string, limit = 26): string {
  return name.length > limit ? `${name.slice(0, limit - 1)}…` : name;
}

/**
 * The default tooltip cannot be used here: it would list the invisible `offset`
 * segment and show both values as raw millisecond counts.
 */
function TimelineTooltip({ active, payload }: Partial<TooltipContentProps<number, string>>) {
  if (!active || !payload || payload.length === 0) return null;

  const row = payload[0]?.payload as Row | undefined;
  if (!row) return null;

  return (
    <div className="chart-tooltip">
      <strong>{row.name}</strong>
      <div>
        {formatDate(new Date(row.start))} — {formatDate(new Date(row.end))}
      </div>
      <div>
        {row.days} gun · {taskStatusLabels[row.status]}
      </div>
    </div>
  );
}
