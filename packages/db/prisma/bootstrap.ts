// Creates the first platform system admin, from the environment.
//
// Run via `pnpm --filter @breakpoint/db db:bootstrap`, which loads the root
// .env with dotenv-cli first. Importing the client before DATABASE_URL is set
// would build the Postgres adapter with an undefined connection string.
//
// This exists because the alternative is worse in both directions. A migration
// that created an admin would put a known-password account in every deployment
// that ever runs it; a seed that created one is a file with the password
// printed in it. An environment variable is read once, by whoever is deploying,
// and leaves nothing behind.
//
// Idempotent: running it again on an existing account resets the password,
// revokes its sessions and re-grants the role rather than failing or creating a
// second one. That is the recovery path when nobody can sign in any more.
import { prisma } from "../src/client";
import { bootstrapSystemAdmin } from "../src/bootstrap";

async function main() {
  const email = process.env.SYSTEM_ADMIN_EMAIL;
  const password = process.env.SYSTEM_ADMIN_PASSWORD;

  const account = await bootstrapSystemAdmin(prisma, { email: email ?? "", password: password ?? "" });

  console.log(`System admin ready: ${account.email}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(1);
  });
