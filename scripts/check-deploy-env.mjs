#!/usr/bin/env node
// Run before `migrate`/`api`/`web` in docker-compose.prod.yml (see the
// "preflight" service). Compose's own `${VAR:?message}` guards only check
// that a variable is set -- they say nothing about whether it is still the
// literal placeholder sitting in .env.example, or a value that will actively
// break something (a POSTGRES_PASSWORD with characters that corrupt the
// DATABASE_URL it gets interpolated into). This is the check for that.
//
// Deliberately narrow: it rejects exact known-placeholder values and
// structural problems, not "looks like a dev value" in general -- WEB_ORIGIN
// and NEXT_PUBLIC_API_URL pointing at localhost is completely legitimate for
// a real single-machine deployment, and this must not fail that.
//
// No dependencies on purpose: it runs from apps/api/Dockerfile's api-base
// stage, before the workspace install, so it only has what plain Node ships
// with.

/** @type {{ name: string, check: (value: string) => string | null }[]} */
const RULES = [
  {
    name: "POSTGRES_PASSWORD",
    check(value) {
      if (value === "change-me-before-deploying") {
        return "still the placeholder from .env.example -- set a real password.";
      }
      if (value.length < 12) {
        return "shorter than 12 characters -- generate one with `openssl rand -hex 24`.";
      }
      // These characters corrupt postgresql://user:PASSWORD@host:port/db when
      // interpolated raw (docker-compose.prod.yml does not URL-encode it):
      // a password containing '@' or '/' shifts what the driver reads as the
      // host and database entirely, silently, and the failure it produces
      // (migrate's P1000 authentication error) does not point back here.
      const unsafe = value.match(/[:/?#[\]@]/);
      if (unsafe) {
        return `contains '${unsafe[0]}', which breaks the connection string it gets built into -- regenerate with \`openssl rand -hex 24\` (URL-safe characters only).`;
      }
      return null;
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
    check(value) {
      if (!/^https?:\/\/.+/.test(value)) {
        return "does not look like a URL (expected it to start with http:// or https://).";
      }
      return null;
    },
  },
  {
    name: "NEXT_PUBLIC_API_URL",
    check(value) {
      if (!/^https?:\/\/.+/.test(value)) {
        return "does not look like a URL (expected it to start with http:// or https://).";
      }
      return null;
    },
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
