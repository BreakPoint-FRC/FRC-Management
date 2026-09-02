# Roles

What someone does on the team. This file owns the model: the two axes it is
built from, the rules a set of roles must satisfy, and the decisions behind
both. [authorization.md](authorization.md) covers what a role lets you *do*.

Keys and code are English, matching the rest of the codebase. Everything the
team reads — `Role.name`, `Group.name` — is Turkish and comes from the database,
so a team can rename a position or add a department without a deploy.

Every team defines its own roles. Two rows exist that a team did not choose —
`SYSTEM_ADMIN` (platform level, `teamId` null) and `TEAM_ADMIN` (created with
the team) — and everything else is the team's own, created through the setup
wizard or the roles screen. See [teams.md](teams.md).

## Two independent axes

A role is a **position** (`Role`) plus the **groups** it has authority over. The
axes are independent on purpose: "Yazılım Lead" is a `LEAD` role scoped to
`Yazılım` rather than its own role, so adding a seventh department adds one
scope row instead of doubling the list of roles.

`Role.placement` says how a role relates to the group axis:

| placement | Covers | `AccountRole.groupId` | `RoleGroupScope` |
| --- | --- | --- | --- |
| `IN_GROUP` | the group it was assigned in | required | optional |
| `MANAGES_GROUP` | the scoped groups **and their subtrees** | must be null | required |
| `ABOVE_GROUPS` | the same | must be null | required |
| `TEAM_WIDE` | every group, plus the group-less records | must be null | forbidden |
| `EXTERNAL` | no group; team-wide reach for what it is granted | must be null | forbidden |

This replaced a `GLOBAL`/`GROUP` pair that could only say "this one group" or
"every group". There was no way to write *the Technical Director runs Mechanical,
Software and Electrical but has no business in Media* — and that, not an
exotic case, is what a team of any size actually looks like.

`RoleGroupScope` stores the **roots** of the authority, not its closure. Scoping
to `Teknik` covers `Tasarım` three levels below it, resolved by walking the group
tree at request time, so a subgroup added tomorrow is covered the day it appears.

A starting set of positions — president, vice-president, team lead, mentor, group
lead, group member, team member — is offered at the `ROLES` step of the wizard
([setup.template.ts](../apps/api/src/modules/setup/setup.template.ts)) and can be
renamed, rewired or deleted afterwards. It is a starting point, not a list.

Labels are `Role.name` and `Group.name`; never rebuild this table by hand.
`formatAccountRole(roleName, groupName)` turns one entry into its label
("Programming Lead", "Başkan") and `formatAccountRoles(roles)` turns a whole set
into a sentence.

## This used to be two enums

Until [the role migration](../packages/db/prisma/migrations/20260829090200_migrate_member_roles_to_account_roles/migration.sql),
the axes were a `Role` enum times a `Subteam` enum on a `MemberRole` table. The
idea survived; both axes are rows now.

| Old | New |
| --- | --- |
| `(LEAD, SOFTWARE)` | `AccountRole(role: LEAD, group: Programming)` |
| `(MEMBER, BUSINESS)` | `AccountRole(role: MEMBER, group: Business)` |
| `(MEMBER, null)` | `AccountRole(role: TEAM_MEMBER, group: null)` |
| `(ADMIN, null)` | `AccountRole(role: SYSTEM_ADMIN, group: null)` |
| `Subteam.PR` | `Group("Media")` |
| `Member` | `Account` — the same person, now able to sign in |

What changed is that adding a department or a position is data rather than a
migration, and that a role now carries permissions instead of being a label the
code branched on.

## An account holds a list, not a single role

Roles live in `AccountRole` — `(accountId, roleId, groupId?)` — and an account
has as many rows as it has jobs. This is not incidental: people on this team
really do hold two, and a scalar `role` column cannot describe the roster.

| Account | Rows | Label |
| --- | --- | --- |
| Deniz Kaya | `LEAD@Mechanical`, `VICE_PRESIDENT` | Başkan Yardımcısı, Mechanical Lead |
| Kerem Öztürk | `LEAD@Programming`, `LEAD@Electrical` | Electrical Lead, Programming Lead |
| Selin Aydın | `PRESIDENT`, `MEMBER@Business` | Başkan, Business Üye |

These three are in [the seed](../packages/db/prisma/seed.ts), so the multi-role
case is visible the first time anyone opens the app.

`Account` therefore has **no** `role` column. Reading an account for display
means including its roles. Collapsing this back into a column would lose exactly
the cases it was built for.

## The rules

Two live in the request schema, because the payload alone decides them
([accounts.schema.ts](../apps/api/src/modules/accounts/accounts.schema.ts)):

| Rule | Why |
| --- | --- |
| No duplicate `(roleId, groupId)` pair | Keeps the set a set. Also the only thing covering the constraint gap below. |
| A password is at least 10 characters | Length beats a character-class rule, which mostly teaches people to end everything with "1!". |

Two need the stored `Role`, so they live in
[accounts.service.ts](../apps/api/src/modules/accounts/accounts.service.ts):

| Rule | Why |
| --- | --- |
| An `IN_GROUP` role requires a `groupId` | "Üye" of nothing is not a job. |
| Every other placement must not have one | They carry their coverage on the role itself, so an assignment naming a group would describe something the resolver ignores. Allowing `PRESIDENT@Yazılım` would make the same fact expressible two ways, and the list could then disagree with itself. |
| The role and the group belong to the caller's team | Otherwise a team could grant its people a role from another team by pasting an id, and inherit its permissions with it. |

That pair is a conditional `CHECK` constraint, which Prisma cannot write
— see [authorization.md](authorization.md) for the full list of invariants the
database cannot hold and where each one is enforced instead.

## Writes replace the whole set

`PUT /accounts/:id/roles` takes the entire list and replaces what is stored.
There is no endpoint that adds or removes one role.

That is deliberate. Every rule above is about the set as a whole, so accepting
one role in isolation would mean re-reading the stored set on every write to
validate it, and the request would still be describing an intermediate state the
client cannot see. Taking the whole set means the request carries everything the
rules need.

The replacement runs in one transaction, so an account is never left holding
half a set. Granting an `IN_GROUP` role also creates the matching
`GroupMembership`, because [the authorization check](authorization.md) requires
membership before an `IN_GROUP` role counts. Roles scoped from above create no
membership: a director is not a member of the departments they oversee.

Archiving an account (`DELETE /accounts/:id`, a soft delete) leaves its roles in
place — what someone did is part of the history the archive exists to preserve.

## The primary role is derived, never stored

When only one role fits — a sorted list, a compact table cell — use
`primaryAccountRole(roles)`, which picks the shallowest entry.
`sortAccountRoles` orders a full set the same way.

There is no `isPrimary` column and no `Account.role` kept alongside the table.
Either would be a second copy of a fact the table already holds, and the two
would eventually disagree. Precedence is a display concern, so it lives in the
display helpers in
[packages/types/src/roles.ts](../packages/types/src/roles.ts).

There is no rank column either. `Role.hierarchyLevel` was removed for the same
reason: who outranks whom is the `RoleHierarchy` graph and nothing else, and a
number beside it was a second source of truth for a fact the edges already held.
The depth each role is sorted by is computed from those edges on every read
(`roleDepths`), so it cannot disagree with them.

The relation is transitive without storing that. An edge 1→2 and an edge 2→3
already put 1 above 3, because the resolver walks to arbitrary depth rather than
stopping at the first hop. `GET /roles/graph` returns that closure for the roles
screen to draw.

## Known gap: the unique constraint is partial

`AccountRole` declares `@@unique([accountId, roleId, groupId])`, but Postgres
treats `NULL`s as distinct inside a unique index. A second
`(account, TEAM_ADMIN, null)` row would not be rejected by the database.

`Role` has the same gap for the opposite reason: `@@unique([teamId, key])` does
not stop two platform roles sharing a key, because their `teamId` is null.
Platform roles are only ever written by migrations, which is what closes it.

Prisma can express neither `NULLS NOT DISTINCT` nor a partial index, and adding
one by hand to a migration puts the database permanently out of sync with
`schema.prisma` — every later `migrate dev` would offer to drop it. So the gap
is closed on the write path instead: roles are only ever replaced as a whole
set, and the duplicate rule rejects the payload before it reaches the database.

**Anyone adding a second way to write roles has to re-check this.** A bulk
importer or an "add one role" endpoint that skips the accounts service can
create duplicate team-wide positions that nothing will catch.

## `Group` is now the department

The old `Subteam` enum and the old free-form `Group` table were deliberately
kept apart, because merging them would either force tasks into five fixed
subteams or make a member's identity editable per row.

Both objections went away when roles moved into the database. A department is
now one thing: a `Group` row that owns tasks and meetings, decides which tools
it uses, and is what an `IN_GROUP` role is assigned in.

Groups are also a **tree**. `Group.parentId` nests them to any depth — Teknik >
Mekanik > Tasarım — because how finely a team subdivides itself is a decision for
that team. Two things follow from the tree:

- A role scoped to a group covers everything under it.
- A `GroupTool` row on a group applies to everything under it, until a subgroup
  states its own answer. No row anywhere up the chain still means off.

Groups are retired with `isActive`, never deleted — tasks, meetings and
transactions reference them with `ON DELETE RESTRICT`, so a hard delete would
fail as soon as the department had done any work. Retiring one retires its whole
subtree: a live Tasarım under a retired Mekanik is a department nobody can reach
and nobody meant to keep.

## Changing the set of roles

Adding, renaming or removing a role or a department is now ordinary data:
`POST /roles`, `PATCH /roles/:id`, `POST /groups`. No migration, no deploy.

Three things are refused:

- **Deleting a system role.** `TEAM_ADMIN` is matched by key in the migrations
  and in the lockout guard; removing it would leave a team with no way to
  administer itself.
- **Deleting a role that is still assigned.** The foreign key would stop it
  anyway, but as a `P2003` reading "Referenced record does not exist", which
  describes the opposite of what happened.
- **Demoting the last team admin.** A team without one cannot create accounts,
  edit roles or reach its own settings, and there is no second way in.

`Role.key` is not updatable: it is what code matches on.

`Role.placement` **is**, unlike the old `scope`. Changing it can still invalidate
existing assignments — an `IN_GROUP` role turned `TEAM_WIDE` leaves rows carrying
a `groupId` the model forbids — so `roles.service.update` rewrites those
assignments in the same transaction rather than leaving them. Moving *to*
`IN_GROUP` cannot invent a group, so those assignments are deactivated and have
to be made again deliberately.
