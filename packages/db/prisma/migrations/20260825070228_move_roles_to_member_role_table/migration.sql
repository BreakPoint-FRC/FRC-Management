-- CreateTable
CREATE TABLE "MemberRole" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "subteam" "Subteam",

    CONSTRAINT "MemberRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberRole_memberId_idx" ON "MemberRole"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberRole_memberId_role_subteam_key" ON "MemberRole"("memberId", "role", "subteam");

-- AddForeignKey
ALTER TABLE "MemberRole" ADD CONSTRAINT "MemberRole_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (hand-written; Prisma does not generate this, and it emits the
-- DROP COLUMN below *first*, which would discard every role). Each member's
-- single current role becomes their first MemberRole row. Must run before the
-- columns are dropped.
INSERT INTO "MemberRole" ("id", "memberId", "role", "subteam")
SELECT gen_random_uuid()::text, "id", "role", "subteam" FROM "Member";

-- AlterTable
ALTER TABLE "Member" DROP COLUMN "role",
DROP COLUMN "subteam";
