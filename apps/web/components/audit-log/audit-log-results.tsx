"use client";

import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_TYPE_LABELS,
  type Paginated,
} from "@breakpoint/types";

import { Badge, Empty, ErrorBox, Loading } from "@/components/ui";
import type { ApiError } from "@/lib/api-client";
import type { AuditLogRow } from "@/lib/api-types";
import { auditLogResultKind, summarizeAuditChange } from "@/lib/audit-log";
import { formatDateTime } from "@/lib/format";

interface AuditLogState {
  data: Paginated<AuditLogRow> | null;
  error: ApiError | null;
  loading: boolean;
}

export function AuditLogResults({
  state,
  onPageChange,
  onRetry,
}: {
  state: AuditLogState;
  onPageChange: (page: number) => void;
  onRetry: () => void;
}) {
  const resultKind = auditLogResultKind(state);

  if (resultKind === "loading") return <Loading />;
  if (resultKind === "forbidden") {
    return (
      <div className="error-box" role="alert">
        <strong>Denetim kaydini goruntuleme yetkiniz yok.</strong>
      </div>
    );
  }
  if (resultKind === "error" && state.error) return (
    <div className="stack-sm">
      <ErrorBox error={state.error} />
      <button className="btn" type="button" onClick={onRetry}>Tekrar dene</button>
    </div>
  );
  if (resultKind === "empty") {
    return <Empty>Filtrelere uygun denetim kaydi yok.</Empty>;
  }

  const data = state.data as Paginated<AuditLogRow>;

  return (
    <div className="stack-sm">
      <div className="table-wrap">
        <table className="table audit-log-table">
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Kim</th>
              <th>Ne</th>
              <th>Eski → yeni</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => {
              const summary = summarizeAuditChange(row);
              return (
                <tr key={row.id} data-audit-id={row.id}>
                  <td className="audit-log-date">{formatDateTime(row.createdAt)}</td>
                  <td>{row.actor.fullName}</td>
                  <td>
                    <div className="stack-sm audit-log-event">
                      <span>
                        <Badge>{AUDIT_ENTITY_TYPE_LABELS[row.entityType]}</Badge>{" "}
                        {AUDIT_ACTION_LABELS[row.action]}
                      </span>
                      <span className="small muted audit-log-id" title={row.entityId}>
                        {row.entityId}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="audit-log-change">
                      <span>{summary.oldValue}</span>
                      <span className="muted" aria-hidden="true">
                        →
                      </span>
                      <span>{summary.newValue}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row pagination" aria-label="Sayfalama">
        <button
          className="btn btn-sm"
          type="button"
          disabled={data.page <= 1 || state.loading}
          onClick={() => onPageChange(data.page - 1)}
        >
          Onceki
        </button>
        <span className="small muted">
          Sayfa {data.page} / {data.totalPages} · {data.total} kayit
        </span>
        <button
          className="btn btn-sm"
          type="button"
          disabled={data.page >= data.totalPages || state.loading}
          onClick={() => onPageChange(data.page + 1)}
        >
          Sonraki
        </button>
      </div>
    </div>
  );
}
