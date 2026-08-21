import { config } from "dotenv";
import { defineConfig } from "prisma/config";

config({ path: "../../.env" });

// `prisma generate` runs on every `pnpm install` and never touches a database.
// Demanding DATABASE_URL here would make a fresh clone fail during install —
// before the README's `cp .env.example .env` step has been reached — and the
// error names the config file rather than the missing variable. So the URL is
// passed through only when it exists; commands that actually connect (migrate,
// deploy, studio) still fail without it, with Prisma's own message.
const url = process.env.DATABASE_URL;

if (!url) {
  console.warn(
    "[prisma] DATABASE_URL is not set. `generate` still works, but migrate/deploy/studio need it.\n" +
      "         Copy .env.example to .env at the repository root."
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Picked up by `prisma migrate reset` / `prisma db seed`; the `db:seed`
    // script runs the same file directly.
    seed: "dotenv -e ../../.env -- tsx prisma/seed.ts",
  },
  ...(url ? { datasource: { url } } : {}),
});
