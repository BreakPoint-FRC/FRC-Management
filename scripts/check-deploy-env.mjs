#!/usr/bin/env node
// Run before `migrate`/`api`/`web` in docker-compose.prod.yml (see the
// "preflight" service). Compose's own `${VAR:?message}` guards only check
// that a variable is set -- they say nothing about whether it is still the
// literal placeholder sitting in .env.example, or a value that will actively
// break something (a POSTGRES_PASSWORD with characters that corrupt the
// DATABASE_URL it gets interpolated into). This is the check for that.
//
// Deliberately narrow: it rejects exact known-placeholder values and values
// that cannot safely be interpolated into this repository's raw Postgres URL.
// WEB_ORIGIN and NEXT_PUBLIC_API_URL pointing at localhost is legitimate for a
// real single-machine deployment, and this must not fail that.
//
// No dependencies on purpose: it runs from apps/api/Dockerfile's api-base
// stage, before the workspace install, so it only has what plain Node ships
// with.

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const POSTGRES_PASSWORD = /^[A-Za-z0-9_-]+$/;

/** @param {string} value */
function validateHttpOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return "must use http:// or https://.";
    }
    if (value !== url.origin) {
      return "must be an origin only (no credentials, path, query, fragment, or trailing slash).";
    }
    return null;
  } catch {
    return "is not a valid URL origin.";
  }
}

/** @type {{ name: string, check: (value: string) => string | null }[]} */
const RULES = [
  {
    name: "POSTGRES_USER",
    check(value) {
      return POSTGRES_IDENTIFIER.test(value)
        ? null
        : "must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens.";
    },
  },
  {
    name: "POSTGRES_PASSWORD",
    check(value) {
      if (value === "change-me-before-deploying") {
        return "still the placeholder from .env.example -- set a real password.";
      }
      if (value.length < 12) {
        return "shorter than 12 characters -- generate one with `openssl rand -hex 24`.";
      }
      // Compose constructs DATABASE_URL without percent-encoding components.
      // A denylist is not enough: for example "%40" is decoded to "@" by the
      // URL parser while Postgres initialized the literal "%40" password.
      if (!POSTGRES_PASSWORD.test(value)) {
        return "must contain only letters, numbers, underscores, or hyphens -- regenerate with `openssl rand -hex 24`.";
      }
      return null;
    },
  },
  {
    name: "POSTGRES_DB",
    check(value) {
      return POSTGRES_IDENTIFIER.test(value)
        ? null
        : "must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens.";
    },
  },
  {
    name: "JWT_SECRET",
    check(value) {
      if (value === "dev-only-secret-change-me-0123456789abcdef0123456789abcdef") {
        return "still the placeholder from .env.example -- generate one with `openssl rand -hex 32`.";
      }
      if (value.length < 32) {
        return "shorter than 32 characters -- generate one with `openssl rand -hex 32`.";
      }
      return null;
    },
  },
  {
    name: "WEB_ORIGIN",
    check: validateHttpOrigin,
  },
  {
    name: "NEXT_PUBLIC_API_URL",
    check: validateHttpOrigin,
  },
];

const failures = [];

for (const rule of RULES) {
  const value = process.env[rule.name];
  // Missing entirely is compose's `${VAR:?...}` job, not this script's --
  // skip rather than duplicate that error with a worse message.
  if (!value) continue;

  const problem = rule.check(value);
  if (problem) failures.push(`  ${rule.name}: ${problem}`);
}

if (failures.length > 0) {
  console.error("Refusing to deploy -- .env has values that will not work in production:\n");
  console.error(failures.join("\n"));
  console.error("\nFix these in .env, then run `docker compose -f docker-compose.prod.yml up -d --build` again.");
  process.exit(1);
}

console.log("Deploy preflight: ok.");
