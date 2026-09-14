# syntax=docker/dockerfile:1

# Production image for @breakpoint/web. Build from the repository root:
#
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
#     -t breakpoint-web .
#
# NEXT_PUBLIC_API_URL is required and has no default on purpose: Next.js
# inlines every NEXT_PUBLIC_* variable into the client bundle at build time
# (see the README's PWA section) -- there is no reading it again when the
# container starts, and a forgotten build arg would silently ship a build
# that calls localhost from every browser it runs in. It must be the origin
# a browser can reach the API at (the public one behind your reverse proxy),
# not an internal Docker service name like http://api:4000 -- see
# docs/deployment.md.
#
# Same node:20-alpine on every stage as apps/api/Dockerfile. This app has no
# native dependency of its own, but the workspace install is shared with
# @breakpoint/api's in spirit -- see that file's header for why the base
# image is pinned identically throughout rather than slimmed per stage.
#
# Every stage name here is prefixed web- so it cannot collide with
# apps/api/Dockerfile's stage names -- see that file's header for why that
# matters to `docker compose ... --build` specifically.
FROM node:20-alpine AS web-base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# ---- deps -------------------------------------------------------------
FROM web-base AS web-deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/db/prisma ./packages/db/prisma
COPY packages/db/prisma.config.ts packages/db/prisma.config.ts
COPY packages/types/package.json packages/types/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile

# ---- build --------------------------------------------------------------
FROM web-deps AS web-build
COPY . .
ARG NEXT_PUBLIC_API_URL
RUN test -n "$NEXT_PUBLIC_API_URL" || \
    (echo "error: --build-arg NEXT_PUBLIC_API_URL=<public API origin> is required" >&2 && exit 1)
# apps/web's own build script loads ../../.env (see apps/web/package.json --
# "build": "dotenv -e ../../.env -- next build"); this is the one var it
# needs to exist for a production build. Not a secret -- it ends up readable
# in the shipped bundle regardless.
RUN echo "NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}" > .env
RUN pnpm run build:libs && pnpm --filter @breakpoint/web build

# ---- deploy ---------------------------------------------------------------
# See apps/api/Dockerfile's api-deploy stage for what this does and why
# --ignore-scripts is safe here (nothing in @breakpoint/web's own postinstall
# chain needs a devDependency). The .next build output lives inside
# apps/web/ like any other source file, so it comes along with the rest of
# the package -- no separate COPY needed for it.
FROM web-build AS web-deploy
RUN pnpm --filter @breakpoint/web deploy /app --prod --ignore-scripts

# ---- runtime ----------------------------------------------------------
FROM node:20-alpine AS web-runtime
ENV NODE_ENV=production
WORKDIR /app
# Dedicated, unprivileged -- see apps/api/Dockerfile's api-runtime stage for
# why. --chown covers .next/cache too, which `next start` can write to at
# runtime (on-demand revalidation), not just the files it only reads.
RUN addgroup -g 1001 -S app && adduser -S -u 1001 -G app app
COPY --from=web-deploy --chown=app:app /app .
USER app
EXPOSE 3000
CMD ["node", "scripts/run-next.mjs", "start"]
