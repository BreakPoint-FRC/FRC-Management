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
 * So the editor is assembled here instead, out of two lists:
 *
 *   - the roll call as stored, which is the record and is never recomputed;
 *   - the roster as it stands now, which is where a meeting with no roll call
 *     gets its rows from.
 *
 * The union of the two, not either alone. Only the roster would drop, on the
 * next whole-set `PUT`, anyone who has since left the group -- deleting a
 * record of attendance that actually happened. Only the stored list is the bug
 * this file was written for.
 */
export interface RollCallRow {
  accountId: string;
  fullName: string;
  status: AttendanceStatus;
  note: string | null;
  /**
   * On the stored roll call but not on the roster any more: someone who was in
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

/** An account as `GET /accounts` sends it; only these two fields are needed. */
interface Candidate {
  id: string;
  fullName: string;
}

/**
 * The roll call to draw, sorted by name.
 *
 * `candidates` is `null` while the roster has not been read -- either because
 * it is still loading or because the viewer may not take attendance and so
 * never asks for it. That is not the same as an empty roster: with `null` the
 * stored list is shown as it is and nobody is judged a former member, because
 * that judgement needs a roster to have been read.
 */
export function buildRollCall(
  stored: readonly StoredEntry[],
  candidates: readonly Candidate[] | null
): RollCallRow[] {
  const rows = new Map<string, RollCallRow>();

  for (const person of candidates ?? []) {
    rows.set(person.id, {
      accountId: person.id,
      fullName: person.fullName,
      status: "ABSENT",
      note: null,
      isFormerMember: false,
    });
  }

  for (const entry of stored) {
    const onRoster = rows.get(entry.accountId);
    rows.set(entry.accountId, {
      accountId: entry.accountId,
      // The roster is the fresher of the two names; the stored one is whatever
      // was joined in at read time.
      fullName: onRoster?.fullName ?? entry.fullName,
      status: entry.status,
      note: entry.note,
      isFormerMember: candidates !== null && onRoster === undefined,
    });
  }

  return [...rows.values()].sort((a, b) => a.fullName.localeCompare(b.fullName, "tr"));
}
