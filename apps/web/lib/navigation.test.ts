import { describe, expect, it } from "vitest";

import { visibleNavigationSections } from "./navigation";
import type { PermissionMap } from "./permissions";

const NONE = { canRead: false, canCreate: false, canUpdate: false, canDelete: false };
const READ = { ...NONE, canRead: true };

const ADMIN_PERMISSIONS: PermissionMap = {
  global: { TEAMS: READ, TOOLS: READ, GROUPS: READ, ROLES: READ },
  byGroup: {},
};

function hrefsOf(teamId: string | null | undefined, permissions: PermissionMap) {
  return visibleNavigationSections(teamId, permissions).flatMap((section) =>
    section.items.map((item) => item.href)
  );
}

describe("platform-only navigation", () => {
  it("gives a team account the team sidebar, with no platform routes even when its rows grant them", () => {
    const hrefs = hrefsOf("team-1", ADMIN_PERMISSIONS);

    expect(hrefs).not.toContain("/teams");
    expect(hrefs).not.toContain("/tools");
    expect(hrefs).toContain("/groups");
  });

  it("gives a platform account the short platform sidebar", () => {
    const hrefs = hrefsOf(null, ADMIN_PERMISSIONS);

    expect(hrefs).toContain("/teams");
    expect(hrefs).toContain("/tools");
    expect(hrefs).not.toContain("/groups");
    expect(hrefs).not.toContain("/tasks");
  });

  it("keeps platform routes hidden while the account is loading", () => {
    const hrefs = hrefsOf(undefined, ADMIN_PERMISSIONS);

    expect(hrefs).not.toContain("/teams");
    expect(hrefs).not.toContain("/tools");
  });
});

describe("audit-log navigation", () => {
  it("uses AUDIT_LOG read independently of role-management access", () => {
    const withoutAudit = hrefsOf("team-1", ADMIN_PERMISSIONS);
    const withAudit = hrefsOf("team-1", {
      ...ADMIN_PERMISSIONS,
      global: { ...ADMIN_PERMISSIONS.global, AUDIT_LOG: READ },
    });

    expect(withoutAudit).toContain("/roles");
    expect(withoutAudit).not.toContain("/audit-log");
    expect(withAudit).toContain("/audit-log");
  });

  it("does not advertise the team-wide endpoint for a group-only grant", () => {
    const hrefs = hrefsOf("team-1", {
      global: {},
      byGroup: { "group-1": { AUDIT_LOG: READ } },
    });

    expect(hrefs).not.toContain("/audit-log");
  });
});

describe("section headings", () => {
  it("drops a section entirely once nothing under it is visible", () => {
    const sections = visibleNavigationSections("team-1", { global: {}, byGroup: {} });

    expect(sections.map((section) => section.label)).toEqual([null]);
    expect(sections[0]?.items.map((item) => item.href)).toEqual(["/"]);
  });

  it("keeps a section once at least one of its items is visible", () => {
    const sections = visibleNavigationSections("team-1", {
      global: { GROUPS: READ },
      byGroup: {},
    });

    const teamSection = sections.find((section) => section.label === "Takım");
    expect(teamSection).toBeDefined();
    expect(teamSection?.items.map((item) => item.href)).toEqual(["/groups"]);
  });
});
