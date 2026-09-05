# Teams

How a team comes into existence, who may open one, and what the first-run flow
asks for. [authorization.md](authorization.md) owns who may do what *inside* a
team; this owns everything that happens before there is one.

## One database, many teams

The instance used to *be* the team: there was nothing to scope by, so nothing
was scoped. Now every row that describes the world of a team carries a `teamId`,
and a record from another team answers **404, not 403** — a 403 confirms the id
exists, which is the one thing a caller from another team must not learn.

The two things that carry no `teamId`, and why, are in
[authorization.md](authorization.md#tenancy).

## Two kinds of administrator

| | `SYSTEM_ADMIN` | `TEAM_ADMIN` |
| --- | --- | --- |
| `Account.teamId` | null | the team |
| `Role.teamId` | null | the team |
| Created by | `db:bootstrap` | `POST /teams`, with the team |
| Modules held | `TEAMS` only | everything **except** `TEAMS` |

The two sets do not overlap. `TEAM_ADMIN` is granted every module except
`TEAMS`, because running a team does not include opening new ones; and
`SYSTEM_ADMIN` holds only `TEAMS`, because opening teams does not include
working inside one. There is no `isSystemAdmin` flag and no branch on one
anywhere in the codebase — "who may open a team" is a row in `RolePermission`
like every other question of authority.

That row is a *default*, though, and defaults are editable by whoever edits
roles. A team admin can write a second `TEAM_WIDE` role, grant it `TEAMS` and
hold it, and the `TEAM_WIDE` bypass in `authorize()` reads the placement of a
role rather than whose role it is. So the split is held by a second check that
no row can reach: every `/teams` route (and every `/tools` route) calls
`requirePlatform(req.account)`, which refuses an account that has a `teamId` at
all. `roles.service.replacePermissions` refuses to store such a grant in the
first place. See
[authorization.md](authorization.md#step-4-is-not-a-tenancy).

A system admin belongs to no team on purpose. One that sat inside a team would
be a back door into it — and that is also why holding the other modules would be
pointless: every team-scoped route refuses an account with no team, so those
grants would authorize nothing while still filling the sidebar with links to
pages that answer 403. The web app reflects the same fact: a platform account
sees two nav items, and its overview page drops the season and department cards
rather than drawing them empty.

## The first system admin

Read from the environment, once, by whoever is deploying:

```bash
SYSTEM_ADMIN_EMAIL=... SYSTEM_ADMIN_PASSWORD=... \
  pnpm --filter @breakpoint/db db:bootstrap
```

Not a migration and not the seed, because both are worse. A migration that
created an admin would put a known-password account in every deployment that
ever ran it; a seed that created one is a file with the password printed in it.

It is idempotent: running it again resets the password, clears the temporary
password flag, revokes every live refresh token and restores the single role
assignment in one transaction. That is the recovery path when nobody can sign
in any more, without leaving a session issued under the old password alive.

## Opening a team

`POST /teams { name, adminFullName, adminEmail }` does four things in one
transaction — a team with no administrator is unreachable, and a half-created one
would have to be cleaned up by hand:

1. the `Team` row, with a **draft** name;
2. its `TEAM_ADMIN` role, with every tool but `TEAMS`;
3. the administrator account, with a generated password;
4. the role assignment.

The response carries that password **once**. Nothing stores it and no later
request can retrieve it — there is no mail sending in this project, so the only
copy is on the screen of whoever created the account. The account is flagged
`mustChangePassword`, and until it clears the API refuses every route but
`/auth/me`, `/auth/password` and `/auth/logout`. A temporary password is a way
in, not a credential.

### Why the name is a draft

The groups created in the first step of the wizard already need a `teamId` to
hang from, so the row has to exist before there is a considered answer to what
the team is called. The `NAMING` step asks again and rewrites it.

## The setup wizard

`Team.setupStage` holds where a team has got to. Each step is written as it is
completed, so closing the tab costs nothing.

| Step | Writes | Prerequisite to leave |
| --- | --- | --- |
| `GROUPS` | `Group`, `parentId` | at least one group |
| `ROLES` | `Role`, `RoleGroupScope`, `RoleHierarchy` | — |
| `TOOLS` | `GroupTool` | — |
| `PERMISSIONS` | `RolePermission` | — |
| `NAMING` | `Team.name`, `Season` | a name and a season |
| `ACCOUNTS` | `Account`, `AccountRole` | — |
| `DONE` | `setupCompletedAt` | |

The order is a **dependency order**, not a preference: a role cannot be scoped
to a group that does not exist, a module cannot be assigned to one either, and a
permission cannot be granted on a module no group uses.

Only the two dependencies are enforced. A team that wants two roles and no more
is not wrong, so `ROLES` has no minimum.

`POST /setup/advance` takes no destination — the server decides what next means
and refuses when the current step is unfinished, so a client cannot skip a
prerequisite by naming a later step. `POST /setup/back` does name one, and
accepts only a step already behind the current one.

### Why `NAMING` asks for a season

Every operational record hangs off a `Season`. Without one the team would finish
the wizard and land on a dashboard where no task, meeting or transaction can be
created, and the error would read as a bug rather than as a missing step.

### The role template

`POST /setup/template` writes the starting set in
[setup.template.ts](../apps/api/src/modules/setup/setup.template.ts): president,
vice-president, team lead, mentor, group lead, group member, team member, with
the hierarchy edges and a permission matrix.

Offered rather than imposed, and only while the team has no roles of its own —
re-running it over an edited tree would undo the edits, and "apply a template"
is not what someone means when they press it a second time.

### The wizard owns the order; the endpoints own the rules

Groups, roles, tools, permissions and accounts are created through their own
endpoints, with their own validation. `/setup` adds no write path of its own for
any of them — a second one would have to re-implement the invariants in
[authorization.md](authorization.md#the-rules-the-database-cannot-hold), and
would eventually get one of them wrong. What the setup module owns is the order
and the stage, and nothing else.

### Everything happens on one screen

The whole dashboard is unreachable until `setupStage` is `DONE`, so every step
is done on `/setup` itself: the group tree, the role editor with its hierarchy
links, the per-department module grid, the permission matrix and the account
form. A step that sent someone to another screen would be sending them somewhere
they cannot go.

The editors are not written twice. Four components are shared between the wizard
and the dashboard screens that also use them:

| Component | Wizard step | Dashboard screen |
| --- | --- | --- |
| `components/roles/permission-matrix.tsx` | `PERMISSIONS` | `/roles` |
| `components/roles/role-fields.tsx` | `ROLES` | `/roles` |
| `components/groups/tool-state-grid.tsx` | `TOOLS` | `/groups` |
| `components/accounts/role-assignment-rows.tsx` | `ACCOUNTS` | `/accounts` |

Each is controlled — the caller owns the state and decides what saving means —
because that is the only thing the two callers actually disagree about. A second
copy of the module grid would drift from the first the next time the model
changed, and the model has changed once already.

### Removing a group during setup

`DELETE /groups/:id` takes the whole subtree, and how depends on what is in it.
A department with tasks, meetings, boards or transactions behind it is
**retired** (`isActive = false`), because those records reference it with
`ON DELETE RESTRICT` and a hard delete would either fail or take the history
with it. A department with none is **deleted outright**.

That second case is almost all of setup. A group created a minute ago by mistake
is not history, and retiring it costs something real: it stays invisible in the
pickers while still holding its name against `@@unique([teamId, name])`, so
deleting "Elektronik" and creating "Elektronik" again answers 409.

`GET /groups/tree` returns live groups only unless asked for more
(`?includeInactive=true`), and the `GROUPS` step counts live groups only. Both
follow from the same idea: a retired department cannot be scoped to, assigned a
module or joined, so a wizard that still listed one would be offering a place
that is not a place.

## Archiving a team

`DELETE /teams/:id` deactivates rather than deletes: every operational row
cascades from `Team`, so a hard delete would take a season of work with it on one
mistyped id. Accounts are `RESTRICT` and would refuse anyway — deliberately,
because the people are the part that must not vanish quietly.

Every account in the team is deactivated and every refresh token revoked in the
same transaction. An archived team whose members can still work for fifteen
minutes is not archived.

Reactivation is intentionally unsupported. `PATCH /teams/:id` accepts only a
new `name`; `isActive` is not an update field, and `DELETE /teams/:id` is the
only archival operation. A future reactivation workflow must define which
accounts are restored, which role assignments become active again, and whether
any previous sessions may be recreated. Until those decisions are explicit, an
archived team remains a one-way security boundary.

## Locking a team out

A team always keeps one active `TEAM_ADMIN`. Archiving, suspending or demoting
the last one is refused, because a team without one cannot create accounts, edit
roles or reach its own settings, and there is no second way in — fixing it means
a platform admin and a database.
