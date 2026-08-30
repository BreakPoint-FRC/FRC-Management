-- Member becomes Account: the same person, now able to sign in.
--
-- Hand-written as a RENAME. Prisma's generated diff for this change is
-- `DROP TABLE "Member"` followed by `CREATE TABLE "Account"`, which would take
-- the whole roster with it -- and every task, meeting and transaction that
-- points at it. Editing the SQL before the migration has been applied anywhere
-- is the one case docs/migrations.md allows.
--
-- Foreign keys on MemberRole, GroupMember, Attendance, Task and Transaction
-- follow the table by OID, so they keep working under their old names. Each of
-- those tables is itself replaced or renamed by a later migration in this
-- chain, which is where the stale constraint names go away.

-- RenameTable
ALTER TABLE "Member" RENAME TO "Account";

-- RenameColumn
ALTER TABLE "Account" RENAME COLUMN "name" TO "fullName";

-- RenameIndex
ALTER INDEX "Member_pkey" RENAME TO "Account_pkey";
ALTER INDEX "Member_email_key" RENAME TO "Account_email_key";

-- RenameConstraint
--
-- PostgreSQL 18 gives every NOT NULL its own named catalog entry, so renaming
-- the table leaves constraints called "Member_id_not_null" behind on "Account".
-- On 16 and 17 a NOT NULL is a column attribute with no constraint to rename,
-- and naming one is error 42704.
--
-- Renaming them unconditionally therefore worked on an 18 development machine
-- and failed on the postgres:16 in CI, against a database built from scratch.
-- This loop renames whatever is actually there and skips what is not, so the
-- chain applies identically on every server the project supports. On 16 and 17
-- it is a no-op, and correctly so: there are no names left to be wrong.
DO $$
DECLARE
  rename RECORD;
BEGIN
  FOR rename IN
    SELECT * FROM (VALUES
      ('Member_id_not_null', 'Account_id_not_null'),
      ('Member_name_not_null', 'Account_fullName_not_null'),
      ('Member_email_not_null', 'Account_email_not_null'),
      ('Member_createdAt_not_null', 'Account_createdAt_not_null')
    ) AS names(old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = '"Account"'::regclass AND conname = rename.old_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE "Account" RENAME CONSTRAINT %I TO %I',
        rename.old_name, rename.new_name
      );
    END IF;
  END LOOP;
END $$;

-- AlterTable
-- isActive gates authentication; archivedAt (already present) records that
-- someone left the team. They are different facts, so both are kept.
ALTER TABLE "Account" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- updatedAt is NOT NULL with no database default in schema.prisma -- Prisma
-- writes it from the client. A populated table still needs a value right now,
-- so it is added with a default and the default is dropped again to leave the
-- column exactly as the schema describes it.
ALTER TABLE "Account" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Account" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- passwordHash is NOT NULL and nobody carried over from the old Member table
-- has a password. They get a placeholder that is deliberately not a valid
-- argon2 encoded hash, so verifyPassword rejects it without ever matching:
-- an existing member cannot sign in until an admin sets a real password.
-- Added nullable, backfilled, then tightened -- a bare NOT NULL column on a
-- populated table would fail here even though it works on an empty database.
ALTER TABLE "Account" ADD COLUMN "passwordHash" TEXT;
UPDATE "Account" SET "passwordHash" = '!no-password-set' WHERE "passwordHash" IS NULL;
ALTER TABLE "Account" ALTER COLUMN "passwordHash" SET NOT NULL;

-- CreateTable
-- Refresh tokens are stored hashed so a database dump cannot be replayed as a
-- set of live sessions.
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_accountId_idx" ON "RefreshToken"("accountId");
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
CREATE INDEX "Account_isActive_idx" ON "Account"("isActive");
CREATE INDEX "Account_archivedAt_idx" ON "Account"("archivedAt");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
