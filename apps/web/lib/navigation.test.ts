import { describe, expect, it } from "vitest";

import { visibleNavigationItems } from "./navigation";
import type { PermissionMap } from "./permissions";

const NONE = { canRead: false, canCreate: false, canUpdate: false, canDelete: false };
const READ = { ...NONE, canRead: true };

const ADMIN_PERMISSIONS: PermissionMap = {
  global: { TEAMS: READ, TOOLS: READ, GROUPS: READ, ROLES: READ },
  byGroup: {},
};

describe("platform-only navigation", () => {
  it("hides platform routes from a team account even when its permission rows grant them", () => {
    const hrefs = visibleNavigationItems("team-1", ADMIN_PERMISSIONS).map((item) => item.href);

    expect(hrefs).not.toContain("/teams");
    expect(hrefs).not.toContain("/tools");
    expect(hrefs).toContain("/groups");
  });

  it("shows platform routes to a platform account with the matching permission", () => {
    const hrefs = visibleNavigationItems(null, ADMIN_PERMISSIONS).map((item) => item.href);

    expect(hrefs).toContain("/teams");
    expect(hrefs).toContain("/tools");
  });

  it("keeps platform routes hidden while the account is loading", () => {
    const hrefs = visibleNavigationItems(undefined, ADMIN_PERMISSIONS).map((item) => item.href);

    expect(hrefs).not.toContain("/teams");
    expect(hrefs).not.toContain("/tools");
  });
});

describe("audit-log navigation", () => {
  it("uses AUDIT_LOG read independently of role-management access", () => {
    const withoutAudit = visibleNavigationItems("team-1", ADMIN_PERMISSIONS).map(
      (item) => item.href
    );
    const withAudit = visibleNavigationItems("team-1", {
      ...ADMIN_PERMISSIONS,
      global: { ...ADMIN_PERMISSIONS.global, AUDIT_LOG: READ },
    }).map((item) => item.href);

    expect(withoutAudit).toContain("/roles");
    expect(withoutAudit).not.toContain("/audit-log");
    expect(withAudit).toContain("/audit-log");
  });

  it("does not advertise the team-wide endpoint for a group-only grant", () => {
    const hrefs = visibleNavigationItems("team-1", {
      global: {},
      byGroup: { "group-1": { AUDIT_LOG: READ } },
    }).map((item) => item.href);

    expect(hrefs).not.toContain("/audit-log");
  });
});
