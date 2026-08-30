import { describe, expect, it } from "vitest";

import { can, canAnywhere, type PermissionMap } from "./permissions";

const NONE = { canRead: false, canCreate: false, canUpdate: false, canDelete: false };
const READ = { ...NONE, canRead: true };
const ALL = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };

/** A mentor: reads everything team-wide, writes nothing, in no department. */
const MENTOR: PermissionMap = {
  global: { TASKS: READ, FINANCE: READ },
  byGroup: {},
};

/** A member of Programming: no team-wide write, full-ish rights in one group. */
const MEMBER: PermissionMap = {
  global: { TASKS: READ },
  byGroup: {
    programming: { TASKS: { ...ALL, canDelete: false } },
  },
};

describe("can", () => {
  it("reads the global set when no group is given", () => {
    expect(can(MENTOR, "TASKS", "read")).toBe(true);
    expect(can(MENTOR, "TASKS", "update")).toBe(false);
  });

  it("reads the group set when one is given", () => {
    expect(can(MEMBER, "TASKS", "update", "programming")).toBe(true);
    expect(can(MEMBER, "TASKS", "delete", "programming")).toBe(false);
  });

  it("falls back to the global set for a group with no entry", () => {
    // Mirrors the server: a record in a department the account is not in gets
    // no group permissions, only whatever a team-wide role grants.
    expect(can(MEMBER, "TASKS", "read", "business")).toBe(true);
    expect(can(MEMBER, "TASKS", "update", "business")).toBe(false);
  });

  it("treats a tool with no entry as denied", () => {
    // A module a department does not use has no row, and absence is the safe
    // reading -- the same thing step 5 of the server check does.
    expect(can(MEMBER, "FINANCE", "read", "programming")).toBe(false);
    expect(can(MEMBER, "SPONSORS", "read")).toBe(false);
  });

  it("denies everything when the map is missing", () => {
    // The state before /auth/me has answered. Rendering a button in that gap
    // would flash a control the account may not have.
    expect(can(null, "TASKS", "read")).toBe(false);
    expect(can(undefined, "TASKS", "read")).toBe(false);
  });

  it("treats a null group the same as no group", () => {
    // A cross-group task carries groupId: null, and the server authorizes it
    // on the global path.
    expect(can(MEMBER, "TASKS", "update", null)).toBe(false);
    expect(can(MEMBER, "TASKS", "read", null)).toBe(true);
  });
});

describe("canAnywhere", () => {
  it("is true when only one department allows it", () => {
    // What the nav needs: a lead has no team-wide task write, but hiding Tasks
    // from them would be wrong.
    expect(can(MEMBER, "TASKS", "update")).toBe(false);
    expect(canAnywhere(MEMBER, "TASKS", "update")).toBe(true);
  });

  it("is false when nothing grants it", () => {
    expect(canAnywhere(MEMBER, "TASKS", "delete")).toBe(false);
    expect(canAnywhere(MEMBER, "ROLES")).toBe(false);
  });

  it("still sees a purely global grant", () => {
    expect(canAnywhere(MENTOR, "FINANCE")).toBe(true);
  });
});
