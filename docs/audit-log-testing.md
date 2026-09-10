# Audit log acceptance tests

The audit screen has its own route because #23 authorizes `AUDIT_LOG/read`
independently of `ROLES`. It reuses the existing client API hook and UI primitives;
role changes still use the shared role permission editor.

Use Node 20 and pnpm 9.12.0. Install the browser once:

```sh
pnpm --filter @breakpoint/web exec playwright install chromium
pnpm --filter @breakpoint/web test:e2e
```

The test command builds the shared database and type packages before Playwright
starts, so it also works directly after a clean install.

Playwright starts the web app on port 3100 with API port 4100. The default suite
stubs API responses, not the page: it exercises 26-row pagination, filter query
names and inclusive local dates, invalid date ranges, clearing filters, empty
results, 403, 500, network errors and retry. It also checks independent navigation
permissions and page overflow at 360px and 1280px in light and dark mode. Screenshots
are written to `apps/web/test-results/`; traces are retained on failure.

Account role summaries compare `(roleId, groupId)` pairs before shortening the
display: removed assignments appear on the old side and added assignments on the
new side. Tests cover an edit beyond three unchanged roles, group moves, additions,
removals, clearing all roles, reordered assignments and more than three changes.
The browser suite also checks that the changed assignments are visible and that
the old/new column can be scrolled into view on a phone.

## Real permission change

The real test uses the existing role editor and makes no mocked requests. It
temporarily toggles the seeded MEMBER role's TASKS update permission, checks the
resulting audit row's actor, role ID, action and old/new values, then restores the
original permission matrix in a `finally` cleanup. Use a separate disposable local
database because the test still writes both the change and restoration to history.
Before saving, it reads the role's recent audit IDs. After saving, it requires a
new audit ID for that role and action, checks the saved permission value, and
asserts against that exact rendered row. An older matching row cannot pass it.

Set `DATABASE_URL` to the disposable database before these commands (PowerShell
uses `$env:NAME = 'value'`). Existing environment values take precedence over `.env`.

```sh
pnpm --filter @breakpoint/db db:deploy
pnpm --filter @breakpoint/db db:seed
pnpm build:libs
```

In the API terminal, keep that `DATABASE_URL` and set `API_PORT=4100`,
`WEB_ORIGIN=http://localhost:3100`, and a local-test `JWT_SECRET`, then run
`pnpm --filter @breakpoint/api dev`. In the test terminal set `AUDIT_E2E_REAL=1`
and run `pnpm --filter @breakpoint/web test:e2e`. Without this explicit opt-in,
the real database test is skipped and the run does not certify that criterion.

Inspect the light/dark screenshots and run `pnpm lint`, `pnpm typecheck`,
`pnpm test`, and `pnpm build` before closing the issue. A passing unit suite alone
does not certify the real role-edit flow or the visual acceptance criteria.

## Verification: 2026-09-10

- `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` passed.
- Unit suites: 324 tests passed (215 API, 108 web, 1 database).
- With `AUDIT_E2E_REAL=1`, all 14 browser tests passed, including a real permission
  change with previous audit history already present.
- Light/dark screenshots at 360px and 1280px were inspected; the phone table's
  old/new column remained accessible by horizontal scrolling.
- The real test used a temporary PostgreSQL 18.4 cluster on `127.0.0.1:55432`,
  with all 22 migrations then present and the seed applied. No existing database
  was used.
- This run used Windows, Node 24.15.0 and pnpm 9.12.0. The repository's pinned
  Node 20 environment was not exercised by this verification.
