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

This builds both images, starts Postgres, waits for it to report healthy,
runs `migrate` (applies every pending migration, then exits 0), and only then
starts `api` and `web`. `docker compose -f docker-compose.prod.yml ps` should
settle with `postgres` and `api` both `healthy`; `migrate` shows `exited (0)`,
which is success, not a crash.

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
idempotent in the sense that it always produces one consistent platform
admin — but running it again *resets that admin's password* to whatever is
in `.env` at that moment and *revokes every live refresh token on the entire
platform*, for every team, as its recovery mechanism (see teams.md). Wire it
into a deploy script and every deploy logs everyone out. It is a break-glass
command, run by hand, only when someone actually needs the platform admin's
password reset.

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
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U "$POSTGRES_USER" -Fc -f /tmp/backup.dump "$POSTGRES_DB"
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

**Restoring** — verified against this repository's own dev database while
writing this document, not asserted:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges \
  < backup-2026-09-14.dump
```

The actual command run for that verification (against a local Postgres, not
a Compose stack, but `pg_dump`/`pg_restore` do not know or care which):
`pg_dump -Fc` the seeded dev database, `pg_restore --no-owner --no-privileges`
into a freshly created database, then compared `Account`/`Team` row counts
and the table count in `information_schema.tables` between source and
restore — all identical (25 tables, 14 accounts, 3 teams, same team names and
ids). `--no-owner --no-privileges`: the dump otherwise tries to `ALTER
... OWNER TO` whatever role took the backup, which may not exist or may not
be `POSTGRES_USER` on the machine being restored to.

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
`packages/db/src/client.ts`), so it fails exactly when a real request would,
and it is deliberately unauthenticated: a health probe carries no session,
and "should traffic go here" is not sensitive information.

There is no equivalent readiness check for `web` — it has no database of its
own to be unready for. Its healthcheck (implicit — Compose just waits for the
container to be running) is weaker on purpose; add one if `web` ever gains a
real dependency of its own to be unready about.
