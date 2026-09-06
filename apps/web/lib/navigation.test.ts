import { describe, expect, it } from "vitest";

import { visibleNavigationItems } from "./navigation";
import type { PermissionMap } from "./permissions";

const NONE = { canRead: false, canCreate: false, canUpdate: false, canDelete: false };
const READ = { ...NONE, canRead: true };

const ADMIN_PERMISSIONS: PermissionMap = {
  global: { TEAMS: READ, TOOLS: READ, GROUPS: READ },
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
