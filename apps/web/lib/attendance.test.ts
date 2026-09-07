import { describe, expect, it } from "vitest";

import { buildRollCall, canSaveRollCall } from "./attendance";

const names = (rows: ReturnType<typeof buildRollCall>) => rows.map((row) => row.fullName);

describe("buildRollCall", () => {
  it("lists every member of a meeting that has no roll call yet", () => {
    // The bug this function exists for: POST /meetings writes no attendance
    // rows, so a freshly created meeting arrives with an empty list and the
    // page had nothing to draw. Roll call was impossible on any meeting that
    // was not seeded.
    const rows = buildRollCall([], [
      { id: "a2", fullName: "Deniz Kaya" },
      { id: "a1", fullName: "Ada Yilmaz" },
    ]);

    expect(names(rows)).toEqual(["Ada Yilmaz", "Deniz Kaya"]);
    expect(rows.every((row) => row.status === "ABSENT")).toBe(true);
    expect(rows.every((row) => row.isFormerMember === false)).toBe(true);
  });

  it("keeps what was recorded rather than defaulting it back to absent, and adds nobody else", () => {
    // A roll call that has already been taken once is not re-seeded from the
    // roster: a2 is on the roster here and is not in the stored list, and must
    // not appear just because they exist.
    const rows = buildRollCall(
      [{ accountId: "a1", fullName: "Ada Yilmaz", status: "LATE", note: "Servis gecikti." }],
      [
        { id: "a1", fullName: "Ada Yilmaz" },
        { id: "a2", fullName: "Deniz Kaya" },
      ]
    );

    expect(rows).toEqual([
      {
        accountId: "a1",
        fullName: "Ada Yilmaz",
        status: "LATE",
        note: "Servis gecikti.",
        isFormerMember: false,
      },
    ]);
  });

  it("does not backfill someone who joined the group after the roll call was taken", () => {
    // The bug this replaces: a stored roll call is a record, and the roster is
    // consulted here only to decide isFormerMember below, never to add a row.
    // A February meeting, saved again in March for an unrelated reason, must
    // not end up with an ABSENT entry for someone who joined in March.
    const rows = buildRollCall(
      [{ accountId: "a1", fullName: "Ada Yilmaz", status: "PRESENT", note: null }],
      [
        { id: "a1", fullName: "Ada Yilmaz" },
        { id: "a3", fullName: "Emre Sahin" },
      ]
    );

    expect(names(rows)).toEqual(["Ada Yilmaz"]);
  });

  it("still adds every roster member the very first time a roll call is taken", () => {
    // The other half of the same rule: the empty-stored case is the one and
    // only place the roster is allowed to add rows, and it still has to.
    const rows = buildRollCall(
      [],
      [
        { id: "a1", fullName: "Ada Yilmaz" },
        { id: "a3", fullName: "Emre Sahin" },
      ]
    );

    expect(names(rows)).toEqual(["Ada Yilmaz", "Emre Sahin"]);
    expect(rows.every((row) => row.status === "ABSENT" && row.isFormerMember === false)).toBe(
      true
    );
  });

  it("keeps someone who has since left the group, flagged", () => {
    // The one that matters. PUT /meetings/:id/attendance replaces the whole
    // set, so a stored attendee missing from the payload is deleted. Drawing
    // the editor from the current roster alone would erase, on the next save,
    // the record that this person was in the room.
    const rows = buildRollCall(
      [
        { accountId: "a1", fullName: "Ada Yilmaz", status: "PRESENT", note: null },
        { accountId: "a9", fullName: "Kerem Ates", status: "PRESENT", note: "Ayrildi." },
      ],
      [{ id: "a1", fullName: "Ada Yilmaz" }]
    );

    expect(names(rows)).toEqual(["Ada Yilmaz", "Kerem Ates"]);
    expect(rows[1]).toMatchObject({
      accountId: "a9",
      status: "PRESENT",
      note: "Ayrildi.",
      isFormerMember: true,
    });
  });

  it("marks nobody a former member while the roster is still loading", () => {
    // null is "roster unknown", not "roster empty". Treating the two the same
    // would flag the whole stored list as former members for one render, and a
    // save in that moment would be judged against a roster nobody has read.
    const rows = buildRollCall(
      [{ accountId: "a1", fullName: "Ada Yilmaz", status: "PRESENT", note: null }],
      null
    );

    expect(rows).toEqual([
      {
        accountId: "a1",
        fullName: "Ada Yilmaz",
        status: "PRESENT",
        note: null,
        isFormerMember: false,
      },
    ]);
  });

  it("prefers the roster's spelling of a name over the stored one", () => {
    // Attendance rows carry the name joined in at read time, so the two agree
    // in practice -- but if an account is renamed the roster is the fresher of
    // the two, and a roll call is easier to read against the current names.
    const rows = buildRollCall(
      [{ accountId: "a1", fullName: "Ada Yilmaz", status: "PRESENT", note: null }],
      [{ id: "a1", fullName: "Ada Yilmaz-Demir" }]
    );

    expect(names(rows)).toEqual(["Ada Yilmaz-Demir"]);
    expect(rows[0]?.status).toBe("PRESENT");
  });

  it("sorts by name, diacritics included", () => {
    // Sorted rather than left in the order the two lists happened to arrive in:
    // the roster comes back by name, the stored roll call does not, and a merge
    // of the two would otherwise put whoever was recorded last at the bottom.
    // Compared with localeCompare(_, "tr") to match gantt/page.tsx -- on Node's
    // ICU that agrees with the default collation for these letters, so it is
    // consistency with the rest of the app rather than a behaviour difference.
    const rows = buildRollCall([], [
      { id: "a3", fullName: "Şahin Öztürk" },
      { id: "a2", fullName: "Çetin Aydın" },
      { id: "a1", fullName: "Ada Yılmaz" },
      { id: "a4", fullName: "Simge İlhan" },
    ]);

    // Ş sorts after every plain-S name, not beside them, which is the Turkish
    // alphabet's order (... s, ş, t ...) and is what ICU gives here.
    expect(names(rows)).toEqual([
      "Ada Yılmaz",
      "Çetin Aydın",
      "Simge İlhan",
      "Şahin Öztürk",
    ]);
  });

  it("returns nothing for a group with no members and no roll call", () => {
    expect(buildRollCall([], [])).toEqual([]);
  });
});

describe("canSaveRollCall", () => {
  const READY = {
    mayUpdate: true,
    saving: false,
    candidatesLoading: false,
    candidatesFailed: false,
  };

  it("allows saving once the roster has loaded successfully", () => {
    expect(canSaveRollCall(READY)).toBe(true);
  });

  it("refuses without MEETINGS/update", () => {
    expect(canSaveRollCall({ ...READY, mayUpdate: false })).toBe(false);
  });

  it("refuses a second press while a save is already in flight", () => {
    expect(canSaveRollCall({ ...READY, saving: true })).toBe(false);
  });

  it("refuses while the roster is still loading", () => {
    expect(canSaveRollCall({ ...READY, candidatesLoading: true })).toBe(false);
  });

  it("refuses once the roster request has failed, not just while it is loading", () => {
    // The bug this guards: a failed request also leaves `loading` false, so
    // checking only that would let a save through with an incomplete roster
    // baked into buildRollCall's union.
    expect(canSaveRollCall({ ...READY, candidatesFailed: true })).toBe(false);
  });
});
