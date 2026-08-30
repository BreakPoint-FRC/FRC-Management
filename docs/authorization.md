# Authorization

Who may do what. This file owns the model: the six checks a request goes
through, what a role hierarchy edge means, and the rules the database cannot
hold. [roles.md](roles.md) covers what a role *is*; this covers what one lets
you do.

Enum values, keys and code are English. Everything the team reads — role names,
group names, error messages — is Turkish.

## The pieces

| Table | Answers |
| --- | --- |
| `Account` | Can this person sign in at all? |
| `Group` | Which departments exist? |
| `GroupMembership` | Who is in a department? |
| `Role` | What positions exist, and is each team-wide or per-department? |
| `AccountRole` | Who holds which role, and in which department? |
| `RoleHierarchy` | Which roles inherit from which? |
| `Tool` | Which modules exist? |
| `GroupTool` | Which modules does a department use? |
| `RolePermission` | What may a role do to a module? |

`Account` has no `role` column and no permission flags. Everything about
authority is reached through `AccountRole`, which is what makes it possible for
one person to be Programming Lead and a Strategy member at the same time.

## The six checks

Every decision is made by `authorize()` in
[apps/api/src/lib/authorize.ts](../apps/api/src/lib/authorize.ts). The order is
not arbitrary — the cheap checks come first, and the graph walk comes last.

```
authorize(prisma, { accountId, tool, action, groupId? })

1. Is the account active and not archived?        no -> 401
2. Is the tool switched on system-wide?           no -> 403
3. Does a GLOBAL role already grant the action?   yes -> allow
4. Was a groupId given?                           no  -> 403
5. Is the account an active member of it?         no  -> 403
6. Does the group have this tool enabled?         no  -> 403
7. Do the roles held *in that group* grant it?    no  -> 403, yes -> allow
```

Step 1 is the only 401. The distinction matters to a client: a 401 means stop
reusing this credential, a 403 means the credential is fine and the answer is
still no.

Step 3 is the bypass. A `SYSTEM_ADMIN` is not a member of every department and
must not have to be; neither is a mentor who reads everything. It is
deliberately the only bypass in the system — there is no hard-coded "if admin"
anywhere else.

Step 4 is what a request with no group means: an administrative action, or a
record that belongs to no department (a cross-group task, a team-wide meeting).
Only a GLOBAL role can authorize one, because there is no membership or
`GroupTool` row to consult.

Step 6 is why a Programming lead cannot open Finance even though they run a
department: `FINANCE` is not enabled for Programming, so the request stops
before their role is ever read.

Holding several roles can only ever add permissions. The sets are merged with
OR, so being both a mentor and a member never subtracts from either.

### `groupId` comes from the stored row, not the request body

For anything that already exists, routes read the group off the record before
authorizing:

```ts
const task = await service.groupOf(id);          // the stored groupId
await authorize(app.prisma, { ..., groupId: task.groupId });
```

Trusting the body would let a member move a task into a department they have no
permission over by naming that department in the payload. Moving a record
between groups needs permission over *both*, which is why the PATCH routes
authorize twice.

### Never trust the client

The web app hides buttons a user cannot use. That is a courtesy, not a control:
the request behind every rendered button is authorized on the server, every
time. `GET /auth/me` returns a permission map so the UI knows what to draw, and
a client that lies to itself about it gets a 403.

## Role hierarchy: a parent inherits from its descendants

An edge means **"parent is above child"**, and permission resolution reads it as
the parent getting the union of its descendants' permissions.

```
PRESIDENT ─┐
           ├─> TEAM_LEAD ─> LEAD ─> MEMBER ─> TEAM_MEMBER
VICE_PRES ─┘                 ^
                             │
     TECHNICAL_DIRECTOR ─────┤
     SOCIAL_DIRECTOR ────────┘
```

So a permission added to `MEMBER` reaches everyone above it without a data
migration, and `TEAM_LEAD` gets everything a `LEAD` has by construction rather
than by someone remembering to copy it.

The spec this was built from listed `Programming Lead`, `Mechanical Lead` and
`Business Lead` as separate roles under `Team Lead`. They are one `LEAD` role
here, scoped to a group by `AccountRole.groupId` — the same tree, at one role
per level instead of one per level per department. Adding a seventh department
adds no roles at all.

`Role.hierarchyLevel` is **display ordering only**. Authorization never reads
it. Two sources of truth for "who outranks whom" would eventually disagree, and
the graph is the one with edges to walk; the column is the equivalent of the old
`ROLE_RANK` map, for sorting a list.

## The rules the database cannot hold

Three invariants here are conditional or recursive, and Prisma can express
neither a `CHECK` nor a recursive assertion. Adding one by hand to a migration
puts the database permanently out of sync with `schema.prisma` — every later
`migrate dev` offers to drop it (see [migrations.md](migrations.md)). So they
are enforced on the write path instead, and each has one:

| Invariant | Enforced by |
| --- | --- |
| A `GROUP` role needs a `groupId`; a `GLOBAL` role must not have one | `accounts.service.replaceRoles` |
| A role cannot be its own parent | `roles.service.linkRoles` |
| The hierarchy has no cycles | `roles.service.linkRoles`, by walking descendants before writing the edge |
| No duplicate `(account, role, group)` while `groupId` is null | the whole-set replacement in `accounts.service` |

That last one is the same gap [roles.md](roles.md) documented for the old
`MemberRole`: Postgres treats `NULL`s as distinct inside a unique index, so
`@@unique([accountId, roleId, groupId])` does not stop a second
`(account, SYSTEM_ADMIN, null)` row.

**Anyone adding a second way to write roles has to re-check all four.** A bulk
importer or an "add one role" endpoint that skips these services can write rows
the model cannot describe, and nothing downstream will catch it.

A cycle would be worse than bad data: `authorize()` walks these edges on every
authorized request, so a loop is a hung request rather than a wrong answer.
`expandDescendants` carries its own `seen` guard for exactly that reason — it
does not merely trust the write path.

## Assignments are replaced whole, never one at a time

Roles, permissions, group tools, task assignees and meeting attendance all
arrive as a complete set and replace what was stored. There is no add-one or
remove-one endpoint for any of them, by design:

- The rules are about the set. Whether an entry is a duplicate depends on the
  others, so accepting one in isolation would mean re-reading the stored set on
  every write to validate it.
- A partial request describes an intermediate state the client cannot see, and
  the invariants above have to hold at every moment, not eventually.

Each replacement runs in one transaction, so nothing is ever left holding half
a set.

## Membership follows a group role

Granting someone a group-scoped role also creates their membership of that
group (`accounts.service.replaceRoles`). Without it, step 5 would turn a freshly
appointed lead away from their own department — a bug that looks like a
permissions problem and is not.

The reverse is guarded too: `groups.service.replaceMembers` refuses to remove
someone who still holds a role in the group, naming them. Take the role away
first.

## What the default matrix grants

Written by
[the role migration](../packages/db/prisma/migrations/20260829090200_migrate_member_roles_to_account_roles/migration.sql),
not by the seed — without these rows nobody can be authorized for anything, so a
freshly deployed database would be inert. Only *direct* grants are stored;
inherited ones are resolved from the hierarchy at request time.

| Role | Scope | Grants directly |
| --- | --- | --- |
| `SYSTEM_ADMIN` | GLOBAL | everything, on every tool |
| `PRESIDENT` | GLOBAL | full finance and sponsors; accounts, groups, seasons |
| `VICE_PRESIDENT` | GLOBAL | sponsors, some finance |
| `TEAM_LEAD` | GLOBAL | roster and season reads, finance read |
| `TECHNICAL_DIRECTOR` | GLOBAL | (inherits `LEAD`) |
| `SOCIAL_DIRECTOR` | GLOBAL | sponsors |
| `MENTOR` | GLOBAL | read on everything, write on nothing |
| `LEAD` | GROUP | full tasks, meetings and gantt in the group; roster and group read |
| `MEMBER` | GROUP | create and update tasks in the group |
| `TEAM_MEMBER` | GLOBAL | read tasks, todo, meetings, gantt, calendar, logs |

`SYSTEM_ADMIN` is granted every tool outright rather than by inheritance: its
power must not depend on the shape of a tree an admin can edit. That grant was
written as a `CROSS JOIN` over the tools that existed when the migration ran, so
**a tool added later needs its own `SYSTEM_ADMIN` row** — see
[the calendar migration](../packages/db/prisma/migrations/20260829091000_add_calendar_tool/migration.sql)
for the four lines every future tool has to repeat.

## A tool that only reads other tools

`CALENDAR` grants a view, not data. Every entry it draws belongs to `MEETINGS`
or `TASKS`, so `GET /calendar` authorizes `CALENDAR` read to get in, then checks
each source separately with `canPerform()` and fills only the ones the account
could already have read directly. A denied source comes back empty rather than
as a 403: a member who may see tasks but not meetings still has a calendar worth
showing.

Without that second pass the calendar would be a side door — an account holding
`CALENDAR` but not `MEETINGS` would learn every meeting title on the team by
asking the wrong endpoint. Any future tool that renders another's records owes
the same check.

Departments get `TASKS`, `TODO`, `TASK_LOGS`, `GANTT`, `CALENDAR`, `MEETINGS`,
`ACCOUNTS` and `GROUPS`. `FINANCE` is on for Business only; `SPONSORS` for Business and
Media. `ROLES`, `TOOLS`, `PERMISSIONS` and `SEASONS` are team-wide and have no
`GroupTool` rows at all — a missing row reads as disabled, so a group created
tomorrow does not silently acquire them.

## What this model does not say

`RolePermission` has four flags and no notion of ownership, so it cannot express
"update your own task but not everyone else's". That is a real limit, not an
oversight: adding a scope column would double the size of the matrix for a rule
only some tools want.

The extension point is already there. `authorize()` returns the account's
resolved permission set rather than a boolean, so a service that needs an
ownership rule can layer it on a granted `canUpdate` without a second lookup.
When the first tool actually needs it, that is where it goes.
