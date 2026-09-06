import { describe, expect, it } from "vitest";

import { buildRollCall } from "./attendance";

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

  it("keeps what was recorded rather than defaulting it back to absent", () => {
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
      { accountId: "a2", fullName: "Deniz Kaya", status: "ABSENT", note: null, isFormerMember: false },
    ]);
  });

  it("adds someone who joined the group after the roll call was taken", () => {
    // Decision: a saved roll call is never recomputed, but the editor is drawn
    // from the roster as it stands now, so a new member can be marked without
    // anyone rewriting history.
    const rows = buildRollCall(
      [{ accountId: "a1", fullName: "Ada Yilmaz", status: "PRESENT", note: null }],
      [
        { id: "a1", fullName: "Ada Yilmaz" },
        { id: "a3", fullName: "Emre Sahin" },
      ]
    );

    expect(names(rows)).toEqual(["Ada Yilmaz", "Emre Sahin"]);
    expect(rows[1]).toMatchObject({ accountId: "a3", status: "ABSENT", isFormerMember: false });
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
