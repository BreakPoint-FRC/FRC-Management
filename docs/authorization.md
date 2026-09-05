# Authorization

Who may do what. This file owns the model: the checks a request goes through,
what a role hierarchy edge means, and the rules the database cannot hold.
[roles.md](roles.md) covers what a role *is*; [teams.md](teams.md) covers how a
team comes into existence; this covers what a role lets you do.

Enum values, keys and code are English. Everything the team reads — role names,
group names, error messages — is Turkish.

## The pieces

| Table | Answers |
| --- | --- |
| `Team` | Which teams exist, and has each finished setting itself up? |
| `Account` | Can this person sign in at all, and to which team? |
| `Group` | Which departments exist, and which sits under which? |
| `GroupMembership` | Who is in a department? |
| `Role` | What positions exist, and where does each sit relative to the groups? |
| `RoleGroupScope` | Which groups does a role have authority over? |
| `AccountRole` | Who holds which role, and in which department? |
| `RoleHierarchy` | Which roles inherit from which? |
| `Tool` | Which modules exist? |
| `GroupTool` | Which modules does a department use? |
| `RolePermission` | What may a role do to a module? |

`Account` has no `role` column and no permission flags. Everything about
authority is reached through `AccountRole`, which is what makes it possible for
one person to be Programming Lead and a Strategy member at the same time.

## Tenancy

One database holds many teams. Every row that describes the world of a team
carries a `teamId`, every service filters on it, and the id comes from the
authenticated account rather than from the request body — trusting the body
would let anyone read another team by naming it.

A record from another team answers **404, not 403**. A 403 confirms the id
exists, which is the one thing a caller from another team must not be able to
learn.

Two things deliberately carry no `teamId`:

- **`Tool`** — the module list is a closed enum in code, identical for everyone.
  What a team *does* with a tool is `GroupTool` and `RolePermission`, and both
  reach a team through `Group` / `Role`.
- **`Account.email`** — unique across the platform, not per team. One address is
  one person is one team. Scoping it per team would force the login screen to
  ask which team you meant before it could find you.

`Account.teamId` and `Role.teamId` are nullable, and null means *above every
team*: a platform `SYSTEM_ADMIN` and the role it holds. A system admin that sat
inside one team would be a back door into it.

## Where a role sits: `RolePlacement`

The old `RoleScope` had two values and could only say "this one group" (`GROUP`,
scoped by `AccountRole.groupId`) or "every group" (`GLOBAL`). There was no way
to write *the Technical Director runs Mechanical, Software and Electrical but
has no business in Media*, which is the ordinary case on a team of any size.

| Placement | Covers | Membership needed? | Gated by `GroupTool`? |
| --- | --- | --- | --- |
| `IN_GROUP` | the group in `AccountRole.groupId` | **yes** | yes |
| `MANAGES_GROUP` | its `RoleGroupScope` groups **and their subtrees** | no | yes |
| `ABOVE_GROUPS` | the same | no | yes |
| `TEAM_WIDE` | every group of the team, plus the group-less records | no | **no** |
| `EXTERNAL` | no group; team-wide reach for what it is granted | no | no |

`RoleGroupScope` stores the **roots** of the authority, not its closure. Scoping
a role to `Teknik` covers `Tasarim` three levels below it, resolved by walking
the group tree at request time — so a subgroup added tomorrow is covered the day
it appears, and no role has to be rewritten.

`MANAGES_GROUP` and `ABOVE_GROUPS` are the same to the resolver. They differ in
what they say to a human reading the roles screen, and keeping them apart is
cheaper than discovering later that one label was doing two jobs.

`EXTERNAL` is the mentor, the sponsor liaison, the alumnus: attached to the team
but outside its structure. What it is granted applies team-wide, but it holds
authority in no group, so it never merges with an in-group role to reach
something neither grants on its own.

## The checks

Every decision is made by `authorize()` in
[apps/api/src/lib/authorize.ts](../apps/api/src/lib/authorize.ts). The order is
not arbitrary — the cheap checks come first, and the graph walk comes last.

```
authorize(prisma, { accountId, tool, action, groupId? })

1. Is the account active and not archived?         no -> 401
2. Is the tool switched on system-wide?            no -> 403
3. Is the group in the caller's team?              no -> 404
4. Do TEAM_WIDE / EXTERNAL roles grant it?         yes -> allow
5. Was a groupId given?                            no  -> 403
6. Does any held role cover that group?            no  -> 403
     IN_GROUP counts only with an active membership;
     MANAGES_GROUP / ABOVE_GROUPS carry their own coverage.
7. Does the group have this tool enabled?          no  -> 403
     inherited from the nearest ancestor that states an answer.
8. Do the covering roles grant the action?         no  -> 403, yes -> allow
```

Step 1 is the only 401. The distinction matters to a client: a 401 means stop
reusing this credential, a 403 means the credential is fine and the answer is
still no. Step 3 is the only 404, and it is a 404 rather than a 403 for the
reason given under **Tenancy**.

Step 4 is the bypass. A team admin is not a member of every department and must
not have to be; neither is a mentor who reads everything. It is deliberately the
only bypass in the system — there is no hard-coded "if admin" anywhere else, and
`TEAM_WIDE` is the only placement that also skips step 7.

### Step 4 is not a tenancy

`TEAM_WIDE` means *across this team*, and the bypass reads the placement of a
role, not whose role it is. A team admin writes their own roles, so they can
create a `TEAM_WIDE` role, grant it `TEAMS`, hold it, and reach step 4 with a
yes — which is how a team admin came to be able to open teams and list every
team on the platform.

Nothing in a `RolePermission` row can fix that, because the row is what is being
forged. So the platform surface is guarded on the account instead:

| Route | Guard |
| --- | --- |
| `/teams` (all six) | `requirePlatform(req.account)` beside `authorize` |
| `/tools` (all five) | `requirePlatform(req.account)` beside `authorize` |

`requirePlatform` is the mirror of `requireTeam` in
[tenant.ts](../apps/api/src/lib/tenant.ts): it refuses an account that *has* a
`teamId`. It reads the account rather than a permission row, so a grant written
straight into the database still authorizes nothing, and it is synchronous — it
runs before `authorize` and its queries.

Holding the `TOOLS` permission is a separate question from reaching `/tools`. A
team admin holds it legitimately: it is also the gate on `PUT /groups/:id/tools`,
which decides what modules a department uses. Deciding what Mekanik uses is a
team decision; deciding which modules exist at all is not.

`roles.service.replacePermissions` refuses to store the grant in the first place
(`PLATFORM_ONLY_TOOL_KEYS`), so the table does not fill up with rows that
authorize nothing. It refuses the *flag*, never the entry: the permission editor
sends every tool on every save, so an ordinary role edit always carries a
`TEAMS` row of four falses. `resolvePermissionMatrix` masks the same tools out
of `/auth/me` for the same reason the `SYSTEM_ADMIN` grants were narrowed below
— the UI must not draw a link the API will refuse.

Step 5 is what a request with no group means: an administrative action, or a
record that belongs to no department (a cross-group task, a team-wide meeting).
Only `TEAM_WIDE` or `EXTERNAL` can authorize one, because every other placement
takes its authority from a group and there is no group here to take it from.

Step 7 is why a Yazilim lead cannot open Finance even though they run a
department: `FINANCE` is not enabled for Yazilim, so the request stops before
their role is ever read.

Holding several roles can only ever add permissions. The sets are merged with
OR, so being both a mentor and a member never subtracts from either.

### Tools inherit down the group tree

A `GroupTool` row on `Teknik` applies to `Mekanik` under it and `Tasarim` under
that. The nearest ancestor that states an answer wins, so a subgroup can write
its own row to switch a module back off.

**No row anywhere up the chain still means off.** Enabling a tool stays an
explicit act: absence is the safe reading, and a group created tomorrow does not
silently acquire Finance because somebody once enabled it three levels up.

The groups screen shows both — what a group states for itself, and what actually
applies — because a row can look locally configured when it is really borrowing
the answer from an ancestor, and the person switching it needs to know which of
the two they are about to change.

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
here, scoped to groups by `RoleGroupScope` — the same tree, at one role per level
instead of one per level per department. Adding a seventh department adds no
roles at all.

### The hierarchy is bindings, not numbers

There is no rank column. `Role.hierarchyLevel` was removed, because the graph
already said everything it said and the two could disagree.

The relation is **transitive and nothing stores that**: if 1 is above 2 and 2 is
above 3, then 1 is above 3, because `expandDescendants` walks to arbitrary depth
rather than stopping at the first hop. `GET /roles/graph` returns that closure so
the roles screen can show it; it is computed on read, never written.

Display order is derived the same way — `roleDepths` in
[packages/types/src/roles.ts](../packages/types/src/roles.ts) counts how far each
role sits below the top of the graph. That is a number, and it is not the old
column returning: a value derived from the edges on every read cannot disagree
with the edges.

## The rules the database cannot hold

Three invariants here are conditional or recursive, and Prisma can express
neither a `CHECK` nor a recursive assertion. Adding one by hand to a migration
puts the database permanently out of sync with `schema.prisma` — every later
`migrate dev` offers to drop it (see [migrations.md](migrations.md)). So they
are enforced on the write path instead, and each has one:

| Invariant | Enforced by |
| --- | --- |
| An `IN_GROUP` role needs a `groupId`; every other placement must not have one | `accounts.service.replaceRoles` |
| `MANAGES_GROUP` / `ABOVE_GROUPS` need at least one `RoleGroupScope`; `TEAM_WIDE` / `EXTERNAL` must have none | `roles.service.assertGroupScope` |
| A role cannot be its own parent | `roles.service.linkRoles` |
| The hierarchy has no cycles | `roles.service.linkRoles`, by walking descendants before writing the edge |
| Both ends of a hierarchy edge are in the same team | `roles.service.linkRoles` |
| A group cannot be its own ancestor | `groups.service.assertParent`, via `wouldCreateGroupCycle` |
| Every id in a write belongs to the caller's team | each service, and `resolveSeasonId` for the operational ones |
| A team always keeps one active `TEAM_ADMIN` | `accounts.service.assertNotLastAdmin` |
| A team's own role holds no platform-only tool (`TEAMS`) | `roles.service.replacePermissions`, with `requirePlatform` on the routes as the guarantee |
| No duplicate `(account, role, group)` while `groupId` is null | the whole-set replacement in `accounts.service` |

That last one is the same gap [roles.md](roles.md) documented for the old
`MemberRole`: Postgres treats `NULL`s as distinct inside a unique index, so
`@@unique([accountId, roleId, groupId])` does not stop a second
`(account, TEAM_ADMIN, null)` row.

**Anyone adding a second way to write roles has to re-check all of these.** A
bulk importer or an "add one role" endpoint that skips these services can write
rows the model cannot describe, and nothing downstream will catch it.

A cycle would be worse than bad data: `authorize()` walks both the role edges and
the group tree on every authorized request, so a loop is a hung request rather
than a wrong answer. `expandDescendants` and `expandGroupSubtrees` each carry
their own visited set for exactly that reason — neither merely trusts the write
path.

The last-admin rule is the one that is not about data shape. A team whose only
`TEAM_ADMIN` is archived, suspended or demoted cannot create accounts, edit roles
or reach its own settings, and there is no second way in — fixing it means a
platform admin and a database. Cheaper to refuse.

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

## Membership follows an in-group role

Granting someone an `IN_GROUP` role also creates their membership of that group
(`accounts.service.replaceRoles`). Without it, step 6 would turn a freshly
appointed member away from their own department — a bug that looks like a
permissions problem and is not.

Roles scoped from above create no membership. A director is not a member of the
departments they oversee, and inventing one would put them on the roster.

The reverse is guarded too: `groups.service.replaceMembers` refuses to remove
someone who still holds a role in the group, naming them. Take the role away
first.

## What the default matrix grants

Written by
[the role migration](../packages/db/prisma/migrations/20260829090200_migrate_member_roles_to_account_roles/migration.sql),
not by the seed — without these rows nobody can be authorized for anything, so a
freshly deployed database would be inert. Only *direct* grants are stored;
inherited ones are resolved from the hierarchy at request time.

Two roles are created by the system rather than by a team:

| Role | `teamId` | Placement | Grants directly |
| --- | --- | --- | --- |
| `SYSTEM_ADMIN` | **null** | `TEAM_WIDE` | `TEAMS`, and nothing else |
| `TEAM_ADMIN` | the team | `TEAM_WIDE` | everything **except** `TEAMS` |

The two sets do not overlap at all, and that is the whole of the split. Running
a team does not include opening new ones; opening teams does not include working
inside one. There is no `isSystemAdmin` flag anywhere to say so — "who may open a
team" is a row in `RolePermission` like every other question of authority.

That table is what the two roles are *seeded* with, and a seeded default is not
by itself a rule: a team admin edits roles for a living, and could write a
second `TEAM_WIDE` role granting `TEAMS` to itself. What holds the split is that
`/teams` also asks whether the account belongs to a team at all — see **Step 4
is not a tenancy** above.

`SYSTEM_ADMIN` held every tool until
[20260831090500](../packages/db/prisma/migrations/20260831090500_narrow_system_admin_to_teams/migration.sql),
inherited from the single-team role it replaced. Those grants authorized
nothing — a platform admin has no team, and every team-scoped route refuses an
account with none (`requireTeam`) — but permissions are what the UI draws from,
so they filled the sidebar with eleven links to pages that would answer 403. A
grant that cannot be exercised is not harmless; it is a menu of dead ends.

Both are granted their tools outright rather than by inheritance: the power of an
administrator must not depend on the shape of a role tree that administrator can
edit.

Everything else a team defines for itself. The wizard offers a starting set
([setup.template.ts](../apps/api/src/modules/setup/setup.template.ts)) modelled
on what most FRC teams look like — president, vice-president, team lead, mentor,
group lead, group member, team member — and every row of it can be renamed,
rewired or deleted afterwards. That is the point of roles being rows.

**A tool added later needs a `TEAM_ADMIN` row, not a `SYSTEM_ADMIN` one.** New
teams pick it up on their own, because `teams.service` builds the matrix from a
live query when it creates the role; teams that already exist do not, so the
migration that adds the tool has to grant it to them. See
[the narrowing migration](../packages/db/prisma/migrations/20260831090500_narrow_system_admin_to_teams/migration.sql)
for the statement to copy, and
[the calendar migration](../packages/db/prisma/migrations/20260829091000_add_calendar_tool/migration.sql)
for the rest of what registering a tool involves.

A tool that a platform admin genuinely needs is the rare case, and it is a
deliberate decision rather than a default — grant it explicitly.

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

`ROLES`, `TOOLS`, `PERMISSIONS`, `SEASONS` and `TEAMS` are team-wide and have no
`GroupTool` rows at all — a missing row reads as disabled, so a group created
tomorrow does not silently acquire them. Which of the rest each department uses
is decided at the `TOOLS` step of the setup wizard, one group at a time, and
inherited by its subgroups.

## What this model does not say

`RolePermission` has four flags and no notion of ownership, so it cannot express
"update your own task but not everyone else's". That is a real limit, not an
oversight: adding a scope column would double the size of the matrix for a rule
only some tools want.

The extension point is already there. `authorize()` returns the account's
resolved permission set rather than a boolean, so a service that needs an
ownership rule can layer it on a granted `canUpdate` without a second lookup.
When the first tool actually needs it, that is where it goes.
