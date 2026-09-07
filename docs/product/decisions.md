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
| Group (`groupId` set) | active `GroupMembership` in that group, archived accounts excluded |
| Team-wide (`groupId` null) | every non-archived account on the team |

Team-wide is deliberately not filtered by role. A team meeting is attended by
the team, and there is no "member role" to filter on: roles are rows each team
defines and can rename or delete, so any hardcoded key would be a guess that
breaks on a team that reorganised.

Read from `GET /meetings/:id/attendance-candidates`, not `GET /accounts`. The
first draft asked `/accounts`, which needs `ACCOUNTS/read` — a permission that
can be edited independently of `MEETINGS/update` and, on a team that has done
exactly that for a role that only runs meetings, would leave someone who can
update a meeting through the API still refused the list of people to mark it
against. The dedicated route is authorized against `MEETINGS/update` for the
meeting's own group instead, the same check the page already needs to pass to
show the editor at all, so there is no second permission left that can
disagree with it. It also has no page size to run into: it returns the whole
roster, not a paginated slice, because a team large enough for `/accounts`'s
100-row page to matter was the bug, not a real limit.

The roster is requested only when the viewer may actually take the roll call —
asking anyway would turn a plain member's page into an error box for a request
the route would refuse regardless.

### A saved roll call is a record, not a recomputation

Stored attendance is never recalculated when group membership changes. Past
attendance is the record of who was in the room, and a member list edited in
March must not rewrite what February's meeting says.

That rule cuts both ways, and the roster's part in the editor is smaller than
"union" first suggests:

- **A meeting with no roll call yet** (`stored` is empty) gets its rows from
  the roster, full stop — that is the bug this file exists for, and it is the
  *only* place the roster is allowed to add a row.
- **A meeting that already has one** gets its rows from the stored list alone.
  The roster is still read, but only to flag a stored attendee who is no
  longer on it (`isFormerMember`) — never to add a row for someone who was not
  in the stored list, however current a member they are now.

The first draft did not draw that line: it merged the roster into every
render regardless of whether a roll call already existed, so opening a
months-old meeting and saving it again — for any reason, even to fix one
person's note — wrote a fresh `ABSENT` row for everyone who had joined the
team since. `PUT /meetings/:id/attendance` deletes anyone missing from the
payload, so that write reached the database on the very next save: a March
save of a February meeting invented February attendance for a person who did
not exist there yet. That is the opposite failure from the one this section
opens with, and just as real — see `apps/web/lib/attendance.ts`, where
`stored.length === 0` is the whole guard.

What the roster still protects, once a roll call exists, is the other
direction: someone who has since left the group keeps their recorded status
and is flagged rather than silently dropped on the next whole-set `PUT` — an
editor built from the current roster alone would erase that the moment they
left.
