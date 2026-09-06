# Product decisions

The first three are points where the original product vision (the
pre-development docx, "Sistem Tasarım Notları") and the shipped code disagree.
All three surfaced while writing #28's acceptance checklist — a checklist can't
say what to test until someone decides which behavior is actually V1. Decided by
the team during V1 closeout (2026-09-06); tracked in #22.

The last section is different in kind: a bug fix that had to settle three
questions before it could be written.

## Multi-role behavior: OR-merge, not a single active role

The docx describes "multi-role, single active context": an account holding
two roles works under only one of them at a time, chosen explicitly. The code
has never worked that way. `authorize()` and `resolvePermissionMatrix` merge
every held role's grants with OR (see [authorization.md](../authorization.md),
"holding several roles can only ever add permissions"), and there is no
active-role state anywhere in the web app — `auth-provider.tsx` carries no
such field.

**Decision: keep OR-merge.** It's what's built, tested, and running. A
single-active-role model is a different feature — a role picker in the UI, an
`activeRoleId` on the session, `authorize()` re-derived per selection — not a
V1 fix. The docx's "single active context" line is out of V1 scope; if the
team wants it later, it's a V2 candidate under #29, not a #28 blocker.

## Role hierarchy: multiple parent roles, not one

The docx says "each role has a single parent in the first version." The code
and authorization.md already agree with each other, just not with the docx:
`RoleHierarchy` lets a role report to more than one parent (a `TEAM_LEAD` can
sit under both `PRESIDENT` and `VICE_PRESIDENT`), and inheritance runs
upward — a parent gets the union of what its children can do, never the
reverse.

**Decision: keep multiple parent roles.** Same reasoning as above — it's the
tested, running behavior, and collapsing it to a single parent would be a
schema change (`RoleHierarchy` → a single `parentRoleId` column) with no
product need driving it.

## Meeting → task: two separate flows, no dedicated button

#28's own checklist assumed a "turn this meeting note into a task" action.
`Task` carries no `meetingId`, and there is no such flow anywhere in the API
or web app — creating a meeting and creating a task are, and always have been,
unrelated actions a user does one after the other.

**Decision: that's enough for V1.** A real link (a `meetingId` on `Task`, a
"create task" button on the meeting page) is a small but real feature, not a
bug fix. Noted as a V2 candidate under #29; #28's checklist is written against
the two-separate-flows behavior that actually ships.

## Where a roll call gets its list of people

`POST /meetings` writes a `Meeting` row and nothing else, so a meeting created
from scratch arrives with `attendance: []`. The roll call screen rendered only
that list, which meant attendance could not be taken on any meeting that had
not been seeded — the reason #11 was closed in error, since it was verified
against a sample meeting that already had rows.

Fixing it needed three answers.

### The screen assembles the list, not `create()`

The alternative was writing an `ABSENT` row per member at creation time. That
loses information: the meetings list reads `attendedCount / attendance.length`,
so a meeting that has not happened yet would report "0 / 14", and nothing would
distinguish *no roll call taken* from *everybody was absent*. It also goes
stale, because `PATCH /meetings/:id` can move a meeting to another group and
nothing recomputes the seeded rows.

So [apps/web/lib/attendance.ts](../../apps/web/lib/attendance.ts) merges the
stored roll call with the roster, and the screen draws that. This follows the
pattern already in the tree — the task assignee editor loads its candidates from
`GET /accounts` the same way — and leaves the write path untouched: `PUT
/meetings/:id/attendance` still takes the whole set, so CONTRIBUTING's
"assignments are replaced whole" still holds. The list the user submits is the
list a human confirmed in the room, which is the invariant the endpoint's own
comment already claims.

### Who counts as a member

| Meeting | Roster |
| --- | --- |
| Group (`groupId` set) | `GET /accounts?groupId=<id>` — active `GroupMembership`, archived accounts excluded |
| Team-wide (`groupId` null) | `GET /accounts` — every non-archived account on the team |

Team-wide is deliberately not filtered by role. A team meeting is attended by
the team, and there is no "member role" to filter on: roles are rows each team
defines and can rename or delete, so any hardcoded key would be a guess that
breaks on a team that reorganised.

The roster is requested only when the viewer may actually take the roll call.
Reading it needs `ACCOUNTS/read`, which every role that can update a meeting
holds (`LEAD` and everything above it) and a plain member does not — asking
anyway would turn a member's page into an error box.

Both rosters are capped at 100 by `paginationSchema`. A team larger than that
gets a truncated list, and the page says so rather than quietly leaving people
out.

### A saved roll call is a record, not a recomputation

Stored attendance is never recalculated when group membership changes. Past
attendance is the record of who was in the room, and a member list edited in
March must not rewrite what February's meeting says.

The editor therefore shows the **union** of the stored roll call and the current
roster, not either alone:

- somebody who joined after the roll call was taken appears, absent, and can be
  marked;
- somebody who has since left the group still appears with their recorded
  status, flagged, and is still sent back with every save.

That second one is the whole reason for the union. `PUT
/meetings/:id/attendance` deletes anyone missing from the payload, so an editor
drawn from the current roster alone would erase, on the next save, a record of
attendance that actually happened.
