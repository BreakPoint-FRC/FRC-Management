# Deployment

Getting `api` and `web` running somewhere other than a laptop. This file
covers "how", not "where" — hosting is the team's decision (a VPS, a PaaS,
whatever is on hand). Anything that can run Docker Compose works.

## What's here

`docker-compose.yml` (no suffix) is dev-only: it starts Postgres alone,
because `pnpm dev` runs the apps directly on the host. `docker-compose.prod.yml`
is the opposite — it builds `apps/api/Dockerfile` and `apps/web/Dockerfile`
and runs Postgres, a one-shot migration step, the API, and the web app all in
containers. Read that file's own header comments before your first real
deploy; this document is the narrative version of the same warnings.

## First deploy

```bash
cp .env.example .env
```

Then edit `.env` for real. Six values have no safe default and must change
from what's in `.env.example`:

| Variable | Why |
| --- | --- |
| `POSTGRES_PASSWORD` | Compose refuses to start without it — see its own file |
| `JWT_SECRET` | generate with `openssl rand -hex 32`; every clone of this repo otherwise shares one |
| `SYSTEM_ADMIN_EMAIL` / `SYSTEM_ADMIN_PASSWORD` | the platform admin — see [teams.md](teams.md) |
| `WEB_ORIGIN` | the public web origin, e.g. `https://frc1234.example` — CORS refuses everything else |
| `NEXT_PUBLIC_API_URL` | the public API origin a **browser** can reach — see [Two origins, one confusion](#two-origins-one-confusion) below |

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

This builds every image, runs `preflight` first (rejects `.env` values that
are still `.env.example`'s placeholders, or structurally broken -- see
[scripts/check-deploy-env.mjs](../scripts/check-deploy-env.mjs); a real value
Compose's own `${VAR:?message}` guards would happily accept), starts
Postgres, waits for it to report healthy, runs `migrate` (applies every
pending migration, then exits 0), and only then starts `api` and `web`.
`docker compose -f docker-compose.prod.yml ps` should settle with `postgres`
and `api` both `healthy`; `preflight` and `migrate` show `exited (0)`, which
is success, not a crash.

If `preflight` fails, `docker compose -f docker-compose.prod.yml logs
preflight` names exactly which variable and why -- fix it in `.env` and run
`up -d --build` again. It only rejects values that are provably wrong
(the literal `.env.example` placeholder, a password with characters that
break the connection string, an obviously-too-short secret); it does not
object to `localhost` origins, which is exactly right for a real
single-machine deployment.

`api` and `web` publish their ports on `127.0.0.1` only (see the compose
file's header) -- reachable from this host, not from the network. Put your
reverse proxy (below) on the same host so it can reach `127.0.0.1:4000` /
`127.0.0.1:3000`; a reverse proxy on a *different* host cannot reach these at
all, and needs a different setup than this file provides. `api` also trusts
one hop of `X-Forwarded-For` (`TRUST_PROXY_HOPS=1`, set for you in the
compose file) for exactly this reason: the only thing that can ever connect
to it is that same reverse proxy.

Nothing above created an account yet. Run the bootstrap once:

```bash
set -a && source .env && set +a
docker compose -f docker-compose.prod.yml run --rm \
  -e SYSTEM_ADMIN_EMAIL -e SYSTEM_ADMIN_PASSWORD \
  migrate pnpm --filter @breakpoint/db run db:bootstrap
```

That's the platform admin from `.env` — the account that opens the team's
first real team and its `TEAM_ADMIN` (see [teams.md](teams.md)). Sign in with
it, open a team, and hand the generated admin password (shown once, on
screen) to whoever is actually running the team.

**Do not run `db:bootstrap` again as part of a routine deploy.** It is
idempotent in the sense that it always produces exactly one platform admin —
but running it again *resets that admin's password* to whatever is in `.env`
at that moment and *revokes that admin's live sessions* as its recovery
mechanism (see teams.md). Team members are untouched; this is not a
platform-wide logout. It also refuses to run at all if `SYSTEM_ADMIN_EMAIL`
belongs to an existing account that is not already the platform admin (a
team member's address, say) — recovery is not a way to annex someone else's
account. If `SYSTEM_ADMIN_EMAIL` names a *different* address than last time,
the previous one loses the platform role and its sessions in the same
transaction, so there is still only ever one. Wire this into a deploy script
and every deploy resets the platform admin's password for no reason — it is
a break-glass command, run by hand, only when someone actually needs it.

`db:seed` (sample data — fake accounts, a fake sponsor) exists for local
development only. Do not run it against a production database; there is
nothing in it a real team wants sitting in their ledger.

## Redeploying

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

`migrate` runs again, applies whatever is new, exits, and `api`/`web` restart
on the new images. If `NEXT_PUBLIC_API_URL` did not change, this is enough.
If it did, `web`'s image has to be rebuilt regardless of whether any web code
changed — that value is compiled into the client bundle at `docker build`
time (see `apps/web/Dockerfile`'s header), so `docker compose up` without
`--build` would keep serving the old one indefinitely.

## Two origins, one confusion

`NEXT_PUBLIC_API_URL` is the single easiest thing to get wrong here, because
there are two different addresses for "the API" in play and only one of them
belongs in it:

- `http://api:4000` — reachable **inside** the Compose network, by the other
  containers. `web` never actually uses this: it has no server-side routes or
  actions that call the API (checked — every fetch in `apps/web` runs in the
  browser). `migrate` and `api` itself are the only things that need this
  shape, and they get it from `DATABASE_URL`/internal wiring already, not
  from this variable.
- `https://api.frc1234.example` (or wherever your reverse proxy puts it) —
  reachable from the **browser** of whoever is using the app. This is the one
  `NEXT_PUBLIC_API_URL` needs, because it ends up literally inlined into the
  JavaScript every visitor's browser downloads and runs.

Setting it to the internal name produces a build that works in no browser
anywhere, silently, until someone opens the app and every request fails.

## TLS and a reverse proxy

Nothing in `docker-compose.prod.yml` terminates TLS — `api` and `web` both
listen on plain HTTP, on the assumption that something in front of them
does. [Caddy](https://caddyserver.com) is the least amount of configuration
for automatic HTTPS (a Let's Encrypt certificate, renewed on its own); an
equivalent nginx or Traefik config works the same way if that is what the
team already runs. A minimal `Caddyfile`, on the same host as the containers:

```
frc1234.example {
    reverse_proxy localhost:3000
}

api.frc1234.example {
    # /ready runs a real database query and is meant for the container-
    # internal Compose healthcheck (see docker-compose.prod.yml), which
    # reaches it directly, not through here -- the public internet has no
    # legitimate reason to call it, and every call is a query someone else
    # gets to trigger for free. /health is cheap enough not to matter, but
    # excluded for the same reason: neither is part of the product.
    respond /ready 404
    respond /health 404
    reverse_proxy localhost:4000
}
```

Two DNS records (`frc1234.example`, `api.frc1234.example`), both pointed at
the server; Caddy handles the certificates. `NEXT_PUBLIC_API_URL` in `.env`
is then `https://api.frc1234.example`, and `WEB_ORIGIN` is
`https://frc1234.example`.

## Secrets on the server

`.env` holds real credentials once this is a real deployment (`JWT_SECRET`,
`POSTGRES_PASSWORD`, `SYSTEM_ADMIN_PASSWORD`). It is already gitignored, and
that is necessary but not sufficient on a shared server:

- Keep it readable only by whoever runs `docker compose` (`chmod 600 .env`).
- It is a plain file on disk, not a secrets manager — reasonable for a team
  running this off one small server, and worth revisiting (Docker secrets, a
  managed secrets store) only if that stops being true.
- Back the file up somewhere other than the server it configures. Losing the
  server and this file in the same event means every session is dead and the
  platform admin's password is gone with it.

## Backups

```bash
docker compose -f docker-compose.prod.yml exec postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -Fc -f /tmp/backup.dump "$POSTGRES_DB"'
docker compose -f docker-compose.prod.yml cp postgres:/tmp/backup.dump ./backup-$(date +%F).dump
```

`postgres` deliberately has no port published to the host (see
`docker-compose.prod.yml`) — this runs `pg_dump` *inside* the container over
the compose network rather than opening the database to the host or the
internet for it. `-Fc` is Postgres's custom archive format: compressed, and
restorable with `pg_restore` regardless of what compressed a plain SQL dump
with. Put the resulting file somewhere that is not the same disk as the
database (object storage, another machine) — a backup that lives next to
what it backs up survives every failure except the one it exists for.

The single quotes around the inner command are load-bearing: `$POSTGRES_USER`
and `$POSTGRES_DB` are expanded by the *container's* shell, from the
`POSTGRES_USER`/`POSTGRES_DB` `docker-compose.prod.yml` already gives the
`postgres` service — not by your own shell. Without the quotes your shell
expands them first, using whatever is (or, in a terminal that never ran
`source .env`, is not) currently exported on your machine; a fresh terminal
would silently run `pg_dump -U "" -Fc -f /tmp/backup.dump ""` and fail in a
way that has nothing obviously to do with a missing `source .env`.

**Restoring is not "run pg_restore" — the target database already has this
repo's schema in it**, from `migrate`, and `pg_restore`'s custom format does
not reconcile with an existing schema; it tries to (re)create tables, enums
and constraints that are already there and errors on each collision. Restore
into an empty database, not the live one:

```bash
# 1. Stop the app so nothing writes during the restore. Postgres keeps running.
docker compose -f docker-compose.prod.yml stop api web

# 2. Safety net: back up the current (possibly the reason you're restoring)
#    state before overwriting it, exactly as in Backups above.
docker compose -f docker-compose.prod.yml exec postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -Fc -f /tmp/pre-restore.dump "$POSTGRES_DB"'
docker compose -f docker-compose.prod.yml cp postgres:/tmp/pre-restore.dump \
  ./pre-restore-$(date +%F-%H%M).dump

# 3. Drop and recreate the target database empty. This is the destructive
#    step -- everything currently in it is gone after this line.
docker compose -f docker-compose.prod.yml exec postgres sh -c \
  'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"'

# 4. Restore into it. --exit-on-error turns the first real problem into a
#    stop, rather than pg_restore working through the rest of the archive and
#    leaving you to notice what got skipped from its scrollback.
docker compose -f docker-compose.prod.yml exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error' \
  < backup-2026-09-14.dump

# 5. The backup may predate migrations that have shipped since. A no-op if
#    not; applies what's missing if so.
docker compose -f docker-compose.prod.yml run --rm migrate

# 6. Restart the app and verify before calling this done.
docker compose -f docker-compose.prod.yml up -d api web
curl -sf http://127.0.0.1:4000/ready
```

Then sign in and confirm one real write succeeds (edit anything small) before
telling anyone the restore is finished. `--no-owner --no-privileges`: the
dump otherwise tries to `ALTER ... OWNER TO` whatever role took the backup,
which may not exist, or may not be `POSTGRES_USER`, on the machine being
restored to.

This was verified for real while writing this document — not asserted:
`pg_dump -Fc` the seeded dev database, `pg_restore --no-owner --no-privileges
--exit-on-error` into a freshly created (not the live) database, then
compared `Account`/`Team` row counts and the table count in
`information_schema.tables` between source and restore — all identical (25
tables, 14 accounts, 3 teams, same team names and ids). That first attempt,
restoring straight into the already-migrated dev database rather than a
fresh one, is what surfaced the "restore into an empty database" requirement
above: it failed immediately on the first already-existing table.

A backup that has never been restored is a hypothesis, not a backup — run
this restore procedure against a scratch database on a schedule (monthly is
a reasonable floor), not only when something has already gone wrong and the
restore has to work on the first try.

## Troubleshooting

**`migrate` exits 1 with `P1000: Authentication failed against database
server`, right after `postgres` reported healthy.** Almost always means a
Postgres data volume already exists with *different* credentials than what's
in `.env` right now — commonly because `docker-compose.yml` (dev) was run
from the same directory at some point first. Postgres only applies
`POSTGRES_PASSWORD` while initializing a brand-new, empty data directory; an
existing volume keeps whatever credentials it was first created with; and
`pg_isready` (what the `postgres` healthcheck runs) doesn't check
credentials at all, so the container reports healthy right up until
`migrate` actually tries to authenticate. Confirm with:

```bash
docker volume ls | grep postgres
```

If a volume from an earlier dev-compose run shows up, remove it (this
deletes that volume's data — fine for a stale local test database, not
something to run against a volume with real data):

```bash
docker compose -f docker-compose.prod.yml down
docker volume rm <name-from-the-list-above>
docker compose -f docker-compose.prod.yml up -d --build
```

`docker-compose.prod.yml`'s Postgres volume is named `postgres_data_prod`
specifically so this can't happen going forward between dev and prod
compose in the same clone — but it doesn't retroactively fix a volume that
already exists from before that name changed.

## Health, readiness, and what the difference is for

```
GET /health   -> 200 { status: "ok" }      the process can answer at all
GET /ready    -> 200 { status: "ready" }   the process can also reach Postgres
              -> 503 { status: "not ready" }
```

`api`'s Compose healthcheck polls `/ready`, not `/health` — a container
orchestrator restarting the process because Postgres is briefly slow or
restarting itself would make an outage worse, not better, which is exactly
what would happen if the one health signal available conflated "the process
is broken" with "a dependency is briefly down". `/ready` runs a real `SELECT
1` through the same driver adapter every request goes through (see
`packages/db/src/client.ts`), bounded to 2 seconds so a hanging database
cannot hold the request (and the connection it holds) open indefinitely, and
it is deliberately unauthenticated: a health probe carries no session, and
"should traffic go here" is not sensitive information. Being unauthenticated
is also exactly why it stays off the public route (see the Caddyfile above):
the only caller with a real reason to hit it is the Compose healthcheck,
which reaches it directly over the compose network, not through Caddy — a
public `/ready` is a free database query for anyone who asks.

There is no equivalent readiness check for `web` — it has no database of its
own to be unready for. Its healthcheck (implicit — Compose just waits for the
container to be running) is weaker on purpose; add one if `web` ever gains a
real dependency of its own to be unready about.
