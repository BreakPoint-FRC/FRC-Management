import { describe, expect, it } from "vitest";
import type { AuditAction } from "@breakpoint/types";

import {
  auditLogPath,
  auditLogResultKind,
  EMPTY_AUDIT_LOG_FILTERS,
  summarizeAuditChange,
} from "./audit-log";

describe("auditLogPath", () => {
  it("uses the API query names and omits empty filters", () => {
    const url = new URL(auditLogPath(EMPTY_AUDIT_LOG_FILTERS, 2), "http://localhost");

    expect(url.pathname).toBe("/audit-log");
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: "2", pageSize: "25" });
  });

  it("sends the local start and inclusive end of the selected dates", () => {
    const url = new URL(
      auditLogPath({ entityType: "ROLE", from: "2026-09-01", to: "2026-09-06" }, 1),
      "http://localhost"
    );

    expect(url.searchParams.get("entityType")).toBe("ROLE");
    expect(url.searchParams.get("from")).toBe(new Date(2026, 8, 1, 0, 0, 0, 0).toISOString());
    expect(url.searchParams.get("to")).toBe(
      new Date(2026, 8, 6, 23, 59, 59, 999).toISOString()
    );
  });
});

describe("summarizeAuditChange", () => {
  const roles = (...ids: string[]) => ids.map((roleId) => ({ roleId, groupId: null }));

  it.each([
    [roles("a", "b", "c", "d"), roles("a", "b", "c", "e"), "d", "e"],
    [[{ roleId: "lead", groupId: "mechanical" }], [{ roleId: "lead", groupId: "software" }], "lead @ mechanical", "lead @ software"],
    [roles("a"), roles("a", "b"), "Yok", "b"],
    [roles("a", "b"), roles("a"), "b", "Yok"],
    [roles("a", "b"), [], "a, b", "Yok"],
    [roles("a", "b"), roles("b", "a"), "Degisiklik yok", "Degisiklik yok"],
    [[{ roleId: "a" }], roles("a"), "Degisiklik yok", "Degisiklik yok"],
    [roles("a", "b", "c", "d", "stable"), roles("e", "f", "g", "h", "stable"), "a, b, c (+1)", "e, f, g (+1)"],
  ])("summarizes changed role assignments: %j -> %j", (oldValue, newValue, oldSummary, newSummary) => {
    expect(summarizeAuditChange({ action: "ACCOUNT_ROLES_REPLACED", oldValue, newValue }))
      .toEqual({ oldValue: oldSummary, newValue: newSummary });
  });

  it("ignores newly explicit denied permissions without hiding the actual grant", () => {
    const noFlags = { canRead: false, canCreate: false, canUpdate: false, canDelete: false };
    expect(summarizeAuditChange({ action: "ROLE_PERMISSIONS_REPLACED", oldValue: [],
      newValue: ["ACCOUNTS", "AUDIT_LOG", "CALENDAR", "TASKS"].map((tool) => ({ ...noFlags, tool, canUpdate: tool === "TASKS" })),
    })).toEqual({ oldValue: "TASKS (Yok)", newValue: "TASKS (Guncelleme)" });
  });
  it("shows changes beyond the unchanged first three tools", () => {
    const oldValue = ["ACCOUNTS", "AUDIT_LOG", "FINANCE", "TASKS"].map((tool) => ({ tool, canRead: true }));
    const newValue = oldValue.map((entry) => entry.tool === "TASKS" ? { ...entry, canUpdate: true } : entry);
    expect(summarizeAuditChange({ action: "ROLE_PERMISSIONS_REPLACED", oldValue, newValue }))
      .toEqual({ oldValue: "TASKS (Okuma)", newValue: "TASKS (Okuma/Guncelleme)" });
  });

  it("aligns added and removed tools on both sides", () => {
    expect(summarizeAuditChange({ action: "GROUP_TOOLS_REPLACED",
      oldValue: [{ tool: "TASKS", isEnabled: true }],
      newValue: [{ tool: "FINANCE", isEnabled: false }],
    })).toEqual({ oldValue: "FINANCE (Yok), TASKS (acik)", newValue: "FINANCE (kapali), TASKS (Yok)" });
  });

  it("does not reveal stale rows after errors or revoked access", () => {
    expect(auditLogResultKind({ data: { items: [{}] }, loading: false, error: { status: 403 } })).toBe("forbidden");
    expect(auditLogResultKind({ data: { items: [{}] }, loading: false, error: { status: 500 } })).toBe("error");
  });
  it("renders permission sets as short tool and flag lists", () => {
    expect(
      summarizeAuditChange({
        action: "ROLE_PERMISSIONS_REPLACED",
        oldValue: [{ tool: "TASKS", canRead: true }],
        newValue: [{ tool: "TASKS", canRead: true, canUpdate: true }],
      })
    ).toEqual({ oldValue: "TASKS (Okuma)", newValue: "TASKS (Okuma/Guncelleme)" });
  });

  it("shows only changed fields for object updates", () => {
    expect(
      summarizeAuditChange({
        action: "ROLE_UPDATED",
        oldValue: { name: "Member", placement: "IN_GROUP", description: null },
        newValue: { name: "Lead", placement: "IN_GROUP", description: null },
      })
    ).toEqual({ oldValue: "Ad: Member", newValue: "Ad: Lead" });
  });

  it("caps long summaries and never emits raw JSON", () => {
    const summary = summarizeAuditChange({
      action: "GROUP_TOOLS_REPLACED",
      oldValue: [],
      newValue: ["TASKS", "GANTT", "MEETINGS", "FINANCE"].map((tool) => ({
        tool,
        isEnabled: true,
      })),
    });

    expect(summary.newValue).toContain("(+1)");
    expect(summary.newValue).not.toContain("{");
  });

  it("safely summarizes every current action even when values are unexpected", () => {
    const actions: AuditAction[] = [
      "ACCOUNT_CREATED",
      "ACCOUNT_ROLES_REPLACED",
      "ROLE_CREATED",
      "ROLE_UPDATED",
      "ROLE_DELETED",
      "ROLE_PERMISSIONS_REPLACED",
      "ROLE_HIERARCHY_LINKED",
      "ROLE_HIERARCHY_UNLINKED",
      "GROUP_CREATED",
      "GROUP_PARENT_CHANGED",
      "GROUP_TOOLS_REPLACED",
      "GROUP_REMOVED",
      "GROUP_RETIRED",
      "TEMPLATE_APPLIED",
    ];

    for (const action of actions) {
      const result = summarizeAuditChange({ action, oldValue: null, newValue: { unknown: true } });
      expect(result.oldValue).toBe("Yok");
      expect(result.newValue).toBeTruthy();
      expect(result.newValue).not.toContain("{");
    }
  });
});

describe("auditLogResultKind", () => {
  it("distinguishes loading, empty, data, general error and forbidden states", () => {
    expect(auditLogResultKind({ data: null, error: null, loading: true })).toBe("loading");
    expect(auditLogResultKind({ data: { items: [] }, error: null, loading: false })).toBe("empty");
    expect(auditLogResultKind({ data: { items: [{}] }, error: null, loading: false })).toBe("data");
    expect(auditLogResultKind({ data: null, error: { status: 500 }, loading: false })).toBe(
      "error"
    );
    expect(auditLogResultKind({ data: null, error: { status: 403 }, loading: false })).toBe(
      "forbidden"
    );
  });
});
