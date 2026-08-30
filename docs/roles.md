# Roles

What someone does on the team. This file owns the model: the two axes it is
built from, the rules a set of roles must satisfy, and the decisions behind
both. [authorization.md](authorization.md) covers what a role lets you *do*.

Keys and code are English, matching the rest of the codebase. Everything the
team reads — `Role.name`, `Group.name` — is Turkish and comes from the database,
so a team can rename a position or add a department without a deploy.

## Two independent axes

A role is a **position** (`Role`) plus, for the two positions scoped to a
department, the **group** it applies to. The axes are independent on purpose:
"Yazılım Lead" is `LEAD` assigned in `Programming` rather than its own role, so
adding a seventh department adds one row instead of doubling the list of roles.

`Role.scope` says which axis a role lives on:

| scope | Meaning | `AccountRole.groupId` |
| --- | --- | --- |
| `GLOBAL` | Team-wide. Means the same thing everywhere. | must be null |
| `GROUP` | Only inside the department it was assigned in. | required |

| Role key | scope | Name | Assigned in |
| --- | --- | --- | --- |
| `SYSTEM_ADMIN` | GLOBAL | Sistem Yöneticisi | — |
| `PRESIDENT` | GLOBAL | Başkan | — |
| `VICE_PRESIDENT` | GLOBAL | Başkan Yardımcısı | — |
| `TEAM_LEAD` | GLOBAL | Takım Lideri | — |
| `TECHNICAL_DIRECTOR` | GLOBAL | Teknik Sorumlu | — |
| `SOCIAL_DIRECTOR` | GLOBAL | Sosyal Sorumlu | — |
| `MENTOR` | GLOBAL | Mentor | — |
| `LEAD` | GROUP | Lead | a department |
| `MEMBER` | GROUP | Üye | a department |
| `TEAM_MEMBER` | GLOBAL | Takım Üyesi | — |

`TEAM_MEMBER` is the neutral floor: someone on the team whose department is not
settled yet.

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
| A `GROUP` role requires a `groupId` | "Lead" of nothing is not a job. |
| A `GLOBAL` role must not have one | A president is a president everywhere. Allowing `PRESIDENT@Programming` would make the same fact expressible two ways, and the list could then disagree with itself. |

That second pair is a conditional `CHECK` constraint, which Prisma cannot write
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
half a set. Granting a group-scoped role also creates the matching
`GroupMembership`, because [the authorization check](authorization.md) asks
about membership before it asks about roles.

Archiving an account (`DELETE /accounts/:id`, a soft delete) leaves its roles in
place — what someone did is part of the history the archive exists to preserve.

## The primary role is derived, never stored

When only one role fits — a sorted list, a compact table cell — use
`primaryAccountRole(roles)`, which picks the entry with the lowest
`hierarchyLevel`. `sortAccountRoles` orders a full set the same way.

There is no `isPrimary` column and no `Account.role` kept alongside the table.
Either would be a second copy of a fact the table already holds, and the two
would eventually disagree. Precedence is a display concern, so it lives in the
display helpers in
[packages/types/src/roles.ts](../packages/types/src/roles.ts).

For the same reason `hierarchyLevel` is only ever used for ordering. Who
inherits whose permissions is the `RoleHierarchy` graph and nothing else.

## Known gap: the unique constraint is partial

`AccountRole` declares `@@unique([accountId, roleId, groupId])`, but Postgres
treats `NULL`s as distinct inside a unique index. A second
`(account, SYSTEM_ADMIN, null)` row would not be rejected by the database.

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
it uses, and is what a `GROUP`-scoped role is assigned in. The migration renamed
the existing "Software" group to "Programming" rather than replacing it, so the
tasks already pointing at it kept their group.

Groups are retired with `isActive`, never deleted — tasks, meetings and
transactions reference them with `ON DELETE RESTRICT`, so a hard delete would
fail as soon as the department had done any work.

## Changing the set of roles

Adding, renaming or removing a role or a department is now ordinary data:
`POST /roles`, `PATCH /roles/:id`, `POST /groups`. No migration, no deploy.

Two things are refused:

- **Deleting a system role.** `SYSTEM_ADMIN` and the rest are matched by key in
  the seed and the migrations; removing one would leave an instance with no way
  to administer itself.
- **Deleting a role that is still assigned.** The foreign key would stop it
  anyway, but as a `P2003` reading "Referenced record does not exist", which
  describes the opposite of what happened.

`Role.key` and `Role.scope` are not updatable. The key is what code matches on,
and changing a scope would silently invalidate every existing assignment — a
`GROUP` role turned `GLOBAL` leaves rows carrying a `groupId` the model now
forbids. Retire the role and make a new one.
