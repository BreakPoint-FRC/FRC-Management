"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";

import type { FinanceMonthlyRow } from "@/lib/api-types";
import { formatMoney, monthLabel } from "@/lib/format";

/**
 * Income against expense, month by month.
 *
 * Two bars side by side rather than one stacked or a net line: the question
 * this answers is "what came in versus what went out", and a stack would hide
 * the smaller of the two behind the larger.
 *
 * Every figure the reader sees is formatted from the decimal string the API
 * sent. The Number() below exists only to give the bar a height -- it feeds the
 * geometry and nothing else, and no total is ever computed from it. Summing in
 * the browser is exactly how a budget loses a kurus, which is why the months
 * arrive already added up. See lib/format.ts.
 */
interface Datum extends FinanceMonthlyRow {
  incomeValue: number;
  expenseValue: number;
}

export default function FinanceMonthlyChart({ items }: { items: FinanceMonthlyRow[] }) {
  if (items.length === 0) {
    return <p className="empty">Bu filtrelerle grafik cizilecek kayit yok.</p>;
  }

  const data: Datum[] = items.map((item) => ({
    ...item,
    incomeValue: Number(item.income),
    expenseValue: Number(item.expense),
  }));

  return (
    <div style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        {/* Capped width: with two months in view an uncapped bar spans a third
            of the card and reads as a block of colour rather than a value. */}
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
          maxBarSize={56}
          barGap={2}
        >
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="month"
            tickFormatter={(month: string) => monthLabel(month)}
            stroke="var(--chart-axis)"
            fontSize={11}
          />
          <YAxis
            tickFormatter={compact}
            stroke="var(--chart-axis)"
            fontSize={11}
            width={64}
          />
          <Tooltip cursor={{ fill: "var(--surface-2)", opacity: 0.5 }} content={<MoneyTooltip />} />
          <Legend />
          {/* Categorical slots 1 and 2 -- validated as a pair for colour-vision
              deficiency against this surface in both themes. */}
          <Bar dataKey="incomeValue" name="Gelir" fill="var(--chart-income)" radius={[3, 3, 0, 0]} />
          <Bar
            dataKey="expenseValue"
            name="Gider"
            fill="var(--chart-expense)"
            radius={[3, 3, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Axis ticks only -- full thousands separators would crowd the gutter. The
// abbreviations come from the Turkish locale rather than being spelled out here,
// so "25 B" is bin and "1,2 Mn" is milyon, which is what a reader expects.
const COMPACT = new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 });

function compact(value: number): string {
  return COMPACT.format(value);
}

function MoneyTooltip({ active, payload, label }: Partial<TooltipContentProps<number, string>>) {
  if (!active || !payload || payload.length === 0) return null;

  // Read back off the row rather than out of the chart's own numbers, so the
  // amounts shown are the API's strings to the kurus.
  const row = payload[0]?.payload as Datum | undefined;
  if (!row) return null;

  return (
    <div className="chart-tooltip">
      <strong>{monthLabel(String(label), true)}</strong>
      <div>Gelir: {formatMoney(row.income)}</div>
      <div>Gider: {formatMoney(row.expense)}</div>
      <div>Net: {formatMoney(row.net)}</div>
    </div>
  );
}
