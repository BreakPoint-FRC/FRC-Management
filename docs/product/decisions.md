# Product decisions

Three points where the original product vision (the pre-development docx,
"Sistem Tasarım Notları") and the shipped code disagree. All three surfaced
while writing #28's acceptance checklist — a checklist can't say what to test
until someone decides which behavior is actually V1. Decided by the team
during V1 closeout (2026-09-06); tracked in #22.

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
