# syntax=docker/dockerfile:1

# Production image for @breakpoint/api. Build from the repository root, not
# this directory -- it needs the rest of the pnpm workspace:
#
#   docker build -f apps/api/Dockerfile -t breakpoint-api .
#
# Every stage after `api-base` runs on the same node:20-alpine as
# `api-runtime`, on purpose, and that is not just tidiness. @node-rs/argon2
# (password hashing) is a native addon published as separate prebuilt
# binaries per platform+libc (linux-x64-gnu, linux-x64-musl, ...); pnpm
# installs whichever one matches the machine `pnpm install` actually runs
# ON. Building the deps/build stages on a different base image than
# `api-runtime` -- a common "slim for build, even slimmer for runtime"
# instinct -- would silently install the glibc binary and ship it into a
# musl (alpine) runtime, which does not fail the build; it fails the first
# time a password is hashed, in production. See docs/deployment.md.
#
# Every stage name here is prefixed api- so it cannot collide with
# apps/web/Dockerfile's stage names. `docker compose ... --build` builds
# every service's Dockerfile through one combined BuildKit "bake" request,
# and two Dockerfiles each defining a same-named stage (both had a `deploy`
# stage before this) makes bake treat `--from=deploy` as a registry image
# reference instead of a local stage -- "pull access denied ... deploy" is
# what that failure looks like, not a permissions problem.
FROM node:20-alpine AS api-base
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# ---- deps -------------------------------------------------------------
# Every workspace member's manifest (pnpm needs the whole workspace present
# to reconcile an unfiltered `--frozen-lockfile` install) plus the one piece
# of source `prisma generate` reads without touching a database: the schema.
# Nothing else copied yet, so editing application code never invalidates
# this layer.
FROM api-base AS api-deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/db/prisma ./packages/db/prisma
COPY packages/db/prisma.config.ts packages/db/prisma.config.ts
COPY packages/types/package.json packages/types/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile

# ---- build --------------------------------------------------------------
FROM api-deps AS api-build
COPY . .
RUN pnpm run build:libs && pnpm --filter @breakpoint/api build

# `prisma migrate deploy` and the one-off `db:bootstrap` / `db:seed` scripts
# need the full workspace -- the prisma CLI, tsx, the migrations folder --
# none of which belong in the server's own image. This stage is that: the
# built workspace, kept around under its own name so docker-compose.prod.yml
# can target it directly (`build: {target: api-migrator}`) instead of
# building a second Dockerfile for three commands that only ever run by
# hand. See docs/deployment.md.
FROM api-build AS api-migrator

# ---- deploy ---------------------------------------------------------------
# This package and only the dependencies it needs at runtime, as real files.
# `pnpm deploy` resolves every `workspace:*` dependency (here, @breakpoint/db
# and @breakpoint/types) into its own directory under node_modules -- not a
# symlink pointing back out of the deployed folder, which is what makes the
# result copyable into a from-scratch final stage.
#
# --ignore-scripts: @breakpoint/db's postinstall re-runs `prisma generate`,
# which needs the `prisma` CLI -- a devDependency, deliberately not installed
# by --prod. That client was already generated and compiled in the
# `api-build` stage above and is already sitting in dist/, so this would be
# redundant even if it could run.
FROM api-build AS api-deploy
RUN pnpm --filter @breakpoint/api deploy /app --prod --ignore-scripts

# ---- runtime ----------------------------------------------------------
# Nothing but the deployed app on a fresh base -- no pnpm, no source, no
# devDependencies, no other workspace member's code.
FROM node:20-alpine AS api-runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deploy /app .
EXPOSE 4000
CMD ["node", "dist/server.js"]
