"use client";

import { useMemo, useState, type FormEvent } from "react";
import { AUDIT_ENTITY_TYPES, AUDIT_ENTITY_TYPE_LABELS, type Paginated } from "@breakpoint/types";

import { AuditLogResults } from "@/components/audit-log/audit-log-results";
import { PageHeader } from "@/components/ui";
import { useApi } from "@/hooks/use-api";
import type { AuditLogRow } from "@/lib/api-types";
import {
  auditLogPath,
  EMPTY_AUDIT_LOG_FILTERS,
  type AuditLogFilters,
} from "@/lib/audit-log";

const PAGE_SIZE = 25;

export default function AuditLogPage() {
  const [draft, setDraft] = useState<AuditLogFilters>(EMPTY_AUDIT_LOG_FILTERS);
  const [filters, setFilters] = useState<AuditLogFilters>(EMPTY_AUDIT_LOG_FILTERS);
  const [page, setPage] = useState(1);
  const path = useMemo(() => auditLogPath(filters, page, PAGE_SIZE), [filters, page]);
  const auditLog = useApi<Paginated<AuditLogRow>>(path);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setFilters({ ...draft });
  }

  function clearFilters() {
    setDraft(EMPTY_AUDIT_LOG_FILTERS);
    setFilters(EMPTY_AUDIT_LOG_FILTERS);
    setPage(1);
  }

  return (
    <>
      <PageHeader title="Denetim kaydi" />

      <form className="card audit-log-filters" onSubmit={applyFilters}>
        <div className="field">
          <label htmlFor="audit-entity-type">Kayit turu</label>
          <select
            id="audit-entity-type"
            value={draft.entityType}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                entityType: event.target.value as AuditLogFilters["entityType"],
              }))
            }
          >
            <option value="">Tum turler</option>
            {AUDIT_ENTITY_TYPES.map((entityType) => (
              <option key={entityType} value={entityType}>
                {AUDIT_ENTITY_TYPE_LABELS[entityType]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="audit-from">Baslangic</label>
          <input
            id="audit-from"
            type="date"
            value={draft.from}
            max={draft.to || undefined}
            onChange={(event) =>
              setDraft((current) => ({ ...current, from: event.target.value }))
            }
          />
        </div>

        <div className="field">
          <label htmlFor="audit-to">Bitis</label>
          <input
            id="audit-to"
            type="date"
            value={draft.to}
            min={draft.from || undefined}
            onChange={(event) =>
              setDraft((current) => ({ ...current, to: event.target.value }))
            }
          />
        </div>

        <div className="row audit-log-filter-actions">
          <button className="btn btn-primary" type="submit">
            Uygula
          </button>
          <button className="btn" type="button" onClick={clearFilters}>
            Temizle
          </button>
        </div>
      </form>

      <AuditLogResults state={auditLog} onPageChange={setPage} onRetry={auditLog.reload} />
    </>
  );
}
