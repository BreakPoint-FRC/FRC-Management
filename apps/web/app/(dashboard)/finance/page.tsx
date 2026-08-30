"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { transactionTypeLabels, type Paginated } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import {
  AsyncSection,
  Badge,
  Card,
  ConfirmButton,
  ErrorBox,
  Loading,
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
import type { FinanceMonthlyRow, FinanceSummaryRow, TransactionRow } from "@/lib/api-types";
import { emptyToNull, selectToNull } from "@/lib/form-helpers";
import { formatDate, formatMoney, toDateInput } from "@/lib/format";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";

// Recharts only loads for people who open this page -- see the same note on
// the Gantt page. ssr:false because ResponsiveContainer measures its parent.
const FinanceMonthlyChart = dynamic(() => import("@/components/finance/monthly-chart"), {
  ssr: false,
  loading: () => <Loading />,
});

interface Draft {
  type: string;
  category: string;
  amount: string;
  transactionDate: string;
  groupId: string;
  description: string;
}

const BLANK: Draft = {
  type: "EXPENSE",
  category: "",
  amount: "",
  transactionDate: "",
  groupId: "",
  description: "",
};

export default function FinancePage() {
  const { groups = [], permissions } = useAuth();
  const [groupId, setGroupId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const params = new URLSearchParams({ pageSize: "100" });
  if (groupId) params.set("groupId", groupId);
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  const summaryParams = new URLSearchParams();
  if (groupId) summaryParams.set("groupId", groupId);

  // The chart follows the same slice of the ledger as the table below it --
  // group and date range -- so the two can never be read against each other.
  // The summary above deliberately ignores the dates: it is the season total.
  const monthlyParams = new URLSearchParams();
  if (groupId) monthlyParams.set("groupId", groupId);
  if (from) monthlyParams.set("from", from);
  if (to) monthlyParams.set("to", to);

  const transactions = useApi<Paginated<TransactionRow>>(`/finance?${params.toString()}`);
  const summary = useApi<FinanceSummaryRow>(`/finance/summary?${summaryParams.toString()}`);
  const monthly = useApi<{ items: FinanceMonthlyRow[] }>(
    `/finance/monthly?${monthlyParams.toString()}`
  );
  const mutation = useMutation();

  const [editing, setEditing] = useState<TransactionRow | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);

  const mayCreate = can(permissions, "FINANCE", "create", groupId || null);

  function close() {
    setEditing(null);
    mutation.reset();
  }

  function openCreate() {
    setDraft({ ...BLANK, groupId, transactionDate: toDateInput(new Date()) });
    setEditing("new");
    mutation.reset();
  }

  function openEdit(transaction: TransactionRow) {
    setDraft({
      type: transaction.type,
      category: transaction.category,
      amount: transaction.amount,
      transactionDate: toDateInput(transaction.transactionDate),
      groupId: transaction.groupId ?? "",
      description: transaction.description ?? "",
    });
    setEditing(transaction);
    mutation.reset();
  }

  async function submit() {
    const body = {
      type: draft.type,
      category: draft.category,
      // Sent exactly as typed. Parsing it into a number here is the step that
      // loses a kurus, and the API rejects a JSON number anyway.
      amount: draft.amount.trim(),
      transactionDate: draft.transactionDate,
      groupId: selectToNull(draft.groupId),
      description: emptyToNull(draft.description),
    };

    const ok = await mutation.run(() =>
      editing === "new"
        ? apiClient.post("/finance", body)
        : apiClient.patch(`/finance/${(editing as TransactionRow).id}`, body)
    );
    if (ok) {
      close();
      transactions.reload();
      summary.reload();
      monthly.reload();
    }
  }

  async function remove(id: string) {
    if (await mutation.run(() => apiClient.delete(`/finance/${id}`))) {
      transactions.reload();
      summary.reload();
      monthly.reload();
    }
  }

  return (
    <>
      <PageHeader title="Finans">
        <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          <option value="">Tum takim</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        {mayCreate ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
            + Yeni kayit
          </button>
        ) : null}
      </PageHeader>

      {editing ? (
        <FormPanel
          title={editing === "new" ? "Yeni kayit" : "Kaydi duzenle"}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submit}
          onCancel={close}
        >
          <div className="row">
            <SelectField
              label="Tur"
              value={draft.type}
              options={optionsFrom(transactionTypeLabels)}
              onChange={(type) => setDraft({ ...draft, type })}
              error={issueFor(mutation.error, "type")}
            />
            <TextField
              label="Kategori"
              value={draft.category}
              required
              onChange={(category) => setDraft({ ...draft, category })}
              error={issueFor(mutation.error, "category")}
            />
            <TextField
              label="Tutar"
              value={draft.amount}
              required
              inputMode="decimal"
              placeholder="4750.50"
              hint="Nokta ile ayirin, virgul ile degil."
              onChange={(amount) => setDraft({ ...draft, amount })}
              error={issueFor(mutation.error, "amount")}
            />
          </div>
          <div className="row">
            <TextField
              label="Tarih"
              type="date"
              value={draft.transactionDate}
              required
              onChange={(transactionDate) => setDraft({ ...draft, transactionDate })}
              error={issueFor(mutation.error, "transactionDate")}
            />
            <SelectField
              label="Grup"
              value={draft.groupId}
              placeholder="Takim geneli"
              options={groups.map((group) => ({ value: group.id, label: group.name }))}
              onChange={(value) => setDraft({ ...draft, groupId: value })}
              error={issueFor(mutation.error, "groupId")}
            />
          </div>
          <TextAreaField
            label="Aciklama"
            rows={2}
            value={draft.description}
            onChange={(description) => setDraft({ ...draft, description })}
            error={issueFor(mutation.error, "description")}
          />
        </FormPanel>
      ) : null}

      {!editing && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <div className="stack">
        <AsyncSection state={summary}>
          {(data) => (
            <div className="grid">
              <Card title="Gelir">
                <div className="stat">{formatMoney(data.income)}</div>
              </Card>
              <Card title="Gider">
                <div className="stat">{formatMoney(data.expense)}</div>
              </Card>
              <Card title="Net">
                <div className="stat">{formatMoney(data.net)}</div>
              </Card>
            </div>
          )}
        </AsyncSection>

        <div className="card">
          <p className="card-title">Aylik gelir ve gider</p>
          <AsyncSection state={monthly}>
            {(data) => <FinanceMonthlyChart items={data.items} />}
          </AsyncSection>
        </div>

        <p className="small muted">
          Tutarlar veritabaninda ondalik sayi olarak tutulur ve API ile metin olarak tasinir.
          JSON sayilari kayan noktali oldugu icin, butcenin arada bir kurus kaybetmesinin yolu
          tam olarak budur.
        </p>

        <AsyncSection state={transactions} empty="Bu filtrelerle kayit yok.">
          {(data) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tarih</th>
                    <th>Tur</th>
                    <th>Kategori</th>
                    <th>Aciklama</th>
                    <th>Grup</th>
                    <th className="numeric">Tutar</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((transaction) => (
                    <tr key={transaction.id}>
                      <td>{formatDate(transaction.transactionDate)}</td>
                      <td>
                        <Badge tone={transaction.type === "INCOME" ? "ok" : "danger"}>
                          {transactionTypeLabels[transaction.type]}
                        </Badge>
                      </td>
                      <td>{transaction.category}</td>
                      <td className="muted">{transaction.description ?? "—"}</td>
                      <td>{transaction.groupName ?? <span className="muted">Takim geneli</span>}</td>
                      <td className="numeric">{formatMoney(transaction.amount)}</td>
                      <td>
                        <RowActions>
                          {can(permissions, "FINANCE", "update", transaction.groupId) ? (
                            <button
                              className="btn btn-sm"
                              type="button"
                              onClick={() => openEdit(transaction)}
                            >
                              Duzenle
                            </button>
                          ) : null}
                          {can(permissions, "FINANCE", "delete", transaction.groupId) ? (
                            <ConfirmButton
                              question="Bu kayit silinsin mi?"
                              onConfirm={() => void remove(transaction.id)}
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
      </div>
    </>
  );
}
