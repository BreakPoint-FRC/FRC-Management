import { describe, expect, it } from "vitest";

import { lockedToolsFor, NO_FLAGS, permissionsPayload } from "./permission-matrix";

const FULL = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };

describe("permissionsPayload", () => {
  it("clears create/update/delete on a read-only tool but keeps read", () => {
    const payload = permissionsPayload({ AUDIT_LOG: FULL });

    const audit = payload.find((entry) => entry.tool === "AUDIT_LOG");
    expect(audit).toMatchObject({
      canRead: true,
      canCreate: false,
      canUpdate: false,
      canDelete: false,
    });
  });

  it("leaves an ordinary tool's flags untouched", () => {
    const payload = permissionsPayload({ TASKS: FULL });

    expect(payload.find((entry) => entry.tool === "TASKS")).toMatchObject(FULL);
  });

  it("still zeroes every flag on a whole-tool-locked entry, read-only or not", () => {
    const payload = permissionsPayload(
      { TEAMS: FULL, AUDIT_LOG: FULL },
      lockedToolsFor("team-1")
    );

    expect(payload.find((entry) => entry.tool === "TEAMS")).toMatchObject(NO_FLAGS);
    // AUDIT_LOG is not platform-only, so lockedToolsFor does not touch it --
    // its own read-only rule is what keeps the mutation flags false here.
    expect(payload.find((entry) => entry.tool === "AUDIT_LOG")).toMatchObject({
      canRead: true,
      canCreate: false,
      canUpdate: false,
      canDelete: false,
    });
  });

  it("defaults a tool with no stored row to every flag false", () => {
    const payload = permissionsPayload({});

    expect(payload.every((entry) => !entry.canRead && !entry.canCreate)).toBe(true);
  });
});
