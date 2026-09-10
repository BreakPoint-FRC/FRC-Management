import type { AuditAction, AuditEntityType } from "@breakpoint/types";

import type { AuditLogRow } from "./api-types";

export interface AuditLogFilters {
  entityType: AuditEntityType | "";
  from: string;
  to: string;
}

export const EMPTY_AUDIT_LOG_FILTERS: AuditLogFilters = {
  entityType: "",
  from: "",
  to: "",
};

export type AuditLogResultKind = "loading" | "forbidden" | "error" | "empty" | "data";

/** Keeps the page's mutually exclusive async states explicit and testable. */
export function auditLogResultKind(state: {
  data: { items: unknown[] } | null;
  error: { status: number } | null;
  loading: boolean;
}): AuditLogResultKind {
  if (state.loading && !state.data) return "loading";
  if (state.error?.status === 403) return "forbidden";
  if (state.error) return "error";
  if (!state.data || state.data.items.length === 0) return "empty";
  return "data";
}

function localBoundary(value: string, end: boolean): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(
    year,
    month - 1,
    day,
    end ? 23 : 0,
    end ? 59 : 0,
    end ? 59 : 0,
    end ? 999 : 0
  ).toISOString();
}

/** Builds the endpoint query without renaming or emitting empty filters. */
export function auditLogPath(filters: AuditLogFilters, page: number, pageSize = 25): string {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (filters.entityType) query.set("entityType", filters.entityType);
  if (filters.from) query.set("from", localBoundary(filters.from, false));
  if (filters.to) query.set("to", localBoundary(filters.to, true));
  return `/audit-log?${query.toString()}`;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortList(values: string[]): string {
  if (values.length === 0) return "Yok";
  const shown = values.slice(0, 3);
  return shown.join(", ") + (values.length > shown.length ? ` (+${values.length - shown.length})` : "");
}

function permissionSummary(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const entries = value.flatMap((item) => {
    if (!isRecord(item) || typeof item.tool !== "string") return [];
    if (typeof item.isEnabled === "boolean") {
      return [`${item.tool} (${item.isEnabled ? "acik" : "kapali"})`];
    }
    const flags = [
      item.canRead ? "Okuma" : "",
      item.canCreate ? "Ekleme" : "",
      item.canUpdate ? "Guncelleme" : "",
      item.canDelete ? "Silme" : "",
    ].filter(Boolean);
    return [`${item.tool} (${flags.join("/") || "izin yok"})`];
  });
  return shortList(entries.length === value.length ? entries : [`${value.length} oge`]);
}

function roleAssignmentSummary(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const entries = value.flatMap((item) => {
    if (!isRecord(item) || typeof item.roleId !== "string") return [];
    return [`${item.roleId}${typeof item.groupId === "string" ? ` @ ${item.groupId}` : ""}`];
  });
  return shortList(entries.length === value.length ? entries : [`${value.length} oge`]);
}

const FIELD_LABELS: Record<string, string> = {
  key: "Anahtar",
  name: "Ad",
  fullName: "Ad",
  email: "E-posta",
  description: "Aciklama",
  placement: "Konum",
  isSystemRole: "Sistem rolu",
  groupScopeIds: "Grup kapsami",
  parentId: "Ust grup",
  parentRoleId: "Ust rol",
  childRoleId: "Alt rol",
  groups: "Gruplar",
  assignments: "Atamalar",
  roleScopes: "Rol kapsamlari",
  tools: "Moduller",
  roles: "Roller",
  permissionCount: "Izin sayisi",
  hierarchy: "Baglantilar",
  template: "Sablon",
};

function scalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Yok";
  if (typeof value === "boolean") return value ? "Evet" : "Hayir";
  if (["string", "number"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return `${value.length} oge`;
  return "Deger";
}

function objectSummary(value: JsonRecord, keys?: string[]): string {
  const selected = (keys ?? Object.keys(value)).filter((key) => key in value);
  const entries = selected.map((key) => `${FIELD_LABELS[key] ?? key}: ${scalar(value[key])}`);
  return shortList(entries);
}

function changedKeys(oldValue: unknown, newValue: unknown): string[] | undefined {
  if (!isRecord(oldValue) || !isRecord(newValue)) return undefined;
  return [...new Set([...Object.keys(oldValue), ...Object.keys(newValue)])].filter(
    (key) => JSON.stringify(oldValue[key]) !== JSON.stringify(newValue[key])
  );
}

function summarizeSide(action: AuditAction, value: unknown, keys?: string[]): string {
  if (value === null || value === undefined) return "Yok";
  if (action === "ROLE_PERMISSIONS_REPLACED" || action === "GROUP_TOOLS_REPLACED") {
    return permissionSummary(value) ?? scalar(value);
  }
  if (action === "ACCOUNT_ROLES_REPLACED") {
    return roleAssignmentSummary(value) ?? scalar(value);
  }
  if (Array.isArray(value)) return `${value.length} oge`;
  if (isRecord(value)) return objectSummary(value, keys);
  return scalar(value);
}

export function summarizeAuditChange(
  row: Pick<AuditLogRow, "action" | "oldValue" | "newValue">
): { oldValue: string; newValue: string } {
  if (row.action === "ACCOUNT_ROLES_REPLACED" &&
      Array.isArray(row.oldValue) && Array.isArray(row.newValue) &&
      [...row.oldValue, ...row.newValue].every((entry) =>
        isRecord(entry) && typeof entry.roleId === "string" &&
        (entry.groupId == null || typeof entry.groupId === "string"))) {
    const key = (entry: JsonRecord) => JSON.stringify([entry.roleId, entry.groupId ?? null]);
    const before = new Map(row.oldValue.map((entry: JsonRecord) => [key(entry), entry]));
    const after = new Map(row.newValue.map((entry: JsonRecord) => [key(entry), entry]));
    const removed = [...before.keys()].sort().filter((id) => !after.has(id));
    const added = [...after.keys()].sort().filter((id) => !before.has(id));
    if (removed.length === 0 && added.length === 0) {
      return { oldValue: "Degisiklik yok", newValue: "Degisiklik yok" };
    }
    return {
      oldValue: roleAssignmentSummary(removed.map((id) => before.get(id)))!,
      newValue: roleAssignmentSummary(added.map((id) => after.get(id)))!,
    };
  }
  // Compare before truncating: an unchanged prefix must never hide the edit.
  if ((row.action === "ROLE_PERMISSIONS_REPLACED" || row.action === "GROUP_TOOLS_REPLACED") &&
      Array.isArray(row.oldValue) && Array.isArray(row.newValue) &&
      [...row.oldValue, ...row.newValue].every((entry) => isRecord(entry) && typeof entry.tool === "string")) {
    const before = new Map(row.oldValue.map((entry) => [entry.tool as string, entry as JsonRecord]));
    const after = new Map(row.newValue.map((entry) => [entry.tool as string, entry as JsonRecord]));
    const fields = row.action === "GROUP_TOOLS_REPLACED"
      ? ["isEnabled"] : ["canRead", "canCreate", "canUpdate", "canDelete"];
    // Missing role grants and explicit denial are equivalent. Group overrides
    // differ: removing an explicit false restores inheritance from the parent.
    const tools = [...new Set([...before.keys(), ...after.keys()])].sort().filter((tool) =>
      (row.action === "GROUP_TOOLS_REPLACED" && (!before.has(tool) || !after.has(tool))) ||
      fields.some((field) => Boolean(before.get(tool)?.[field]) !== Boolean(after.get(tool)?.[field]))
    );
    if (tools.length === 0) return { oldValue: "Degisiklik yok", newValue: "Degisiklik yok" };
    const side = (entries: Map<string, JsonRecord>) => shortList(tools.map((tool) =>
      entries.has(tool) ? permissionSummary([entries.get(tool)])! : `${tool} (Yok)`
    ));
    return { oldValue: side(before), newValue: side(after) };
  }
  const keys = changedKeys(row.oldValue, row.newValue);
  return {
    oldValue: summarizeSide(row.action, row.oldValue, keys),
    newValue: summarizeSide(row.action, row.newValue, keys),
  };
}
