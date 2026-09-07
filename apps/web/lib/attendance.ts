import type { AttendanceStatus } from "@breakpoint/types";

/**
 * Who a roll call is taken over.
 *
 * `POST /meetings` writes the meeting and nothing else, so a new meeting has an
 * empty attendance list -- there is no server-side seeding, and deliberately
 * none. A row per member written at creation time would be a record of a roll
 * call nobody took: `attendedCount / attendance.length` would read "0 / 14" for
 * a meeting that has not happened yet, and there would be no way left to tell
 * "not taken" from "everybody was absent". It would also go stale the moment
 * `PATCH /meetings/:id` moves the meeting to another group, because nothing
 * recomputes it.
 *
 * So the editor is assembled here instead, out of two lists -- but only one of
 * them ever *adds* a row:
 *
 *   - the roll call as stored, which is the record. Every stored entry is
 *     always shown, and is never dropped for being off the roster now.
 *   - the roster as it stands, which is where a meeting that has never had a
 *     roll call taken gets its rows from -- and only then. Once a roll call
 *     has been saved once, the stored list *is* the roll call; the roster is
 *     consulted only to flag someone who has since left, never to add a row
 *     for someone who was never marked. Otherwise re-opening a months-old
 *     meeting and saving it -- for any reason, even to fix one person's note
 *     -- would write ABSENT into that meeting for everyone who has joined the
 *     team since, which is a record of a roll call that never happened.
 */
export interface RollCallRow {
  accountId: string;
  fullName: string;
  status: AttendanceStatus;
  note: string | null;
  /**
   * On the stored roll call but not on the current roster: someone who was in
   * the room and has since left the group, or a guest at a group meeting who
   * was never a member of it. Kept, and sent back with every save, so the
   * whole-set replacement does not erase them.
   */
  isFormerMember: boolean;
}

/** An attendance entry as `GET /meetings/:id` sends it. */
interface StoredEntry {
  accountId: string;
  fullName: string;
  status: AttendanceStatus;
  note: string | null;
}

/** A person `GET /meetings/:id/attendance-candidates` sends. */
export interface Candidate {
  id: string;
  fullName: string;
}

/**
 * The roll call to draw, sorted by name.
 *
 * `candidates` is `null` while the roster has not been read -- either because
 * it is still loading, it failed, or the viewer may not take attendance and so
 * never asks for it. That is not the same as an empty roster: with `null` the
 * stored list is shown as it is and nobody is judged a former member, because
 * that judgement needs a roster to have actually been read.
 */
export function buildRollCall(
  stored: readonly StoredEntry[],
  candidates: readonly Candidate[] | null
): RollCallRow[] {
  const candidatesById = new Map((candidates ?? []).map((person) => [person.id, person]));
  const rows = new Map<string, RollCallRow>();

  // The one place a row gets added rather than merged into an existing stored
  // one -- and only when nothing has been recorded yet.
  if (stored.length === 0) {
    for (const person of candidatesById.values()) {
      rows.set(person.id, {
        accountId: person.id,
        fullName: person.fullName,
        status: "ABSENT",
        note: null,
        isFormerMember: false,
      });
    }
  }

  for (const entry of stored) {
    rows.set(entry.accountId, {
      accountId: entry.accountId,
      // The roster is the fresher of the two names when the person is still on
      // it; the stored one is whatever was joined in at read time otherwise.
      fullName: candidatesById.get(entry.accountId)?.fullName ?? entry.fullName,
      status: entry.status,
      note: entry.note,
      isFormerMember: candidates !== null && !candidatesById.has(entry.accountId),
    });
  }

  return [...rows.values()].sort((a, b) => a.fullName.localeCompare(b.fullName, "tr"));
}

/**
 * Whether the save button may be pressed.
 *
 * Saving sends the whole roll call, including rows nobody has touched --
 * `buildRollCall`'s union is the payload, not just a display convenience (see
 * apps/web/app/(dashboard)/meetings/[meetingId]/page.tsx). So it is not enough
 * to hold off while the roster is *loading*: a roster that failed to load
 * leaves `candidates` at `null`, `loading` goes back to `false`, and a press in
 * that moment would save a roll call built from the stored list alone -- which
 * for a brand new meeting is empty, and would report to the server "nobody is
 * here" for whichever query actually failed.
 */
export function canSaveRollCall(state: {
  mayUpdate: boolean;
  saving: boolean;
  candidatesLoading: boolean;
  candidatesFailed: boolean;
}): boolean {
  return (
    state.mayUpdate && !state.saving && !state.candidatesLoading && !state.candidatesFailed
  );
}
