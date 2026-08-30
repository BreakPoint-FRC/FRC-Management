-- CreateEnum
CREATE TYPE "Subteam" AS ENUM ('SOFTWARE', 'MECHANICAL', 'ELECTRONICS', 'PR', 'BUSINESS');

-- AlterEnum
-- Role is rebuilt rather than extended: STUDENT is gone and every other value is
-- new. The USING clause is hand-written -- Prisma generates a plain
-- ("role"::text::"Role_new") cast, which fails on existing STUDENT rows. They
-- become MEMBER (no subteam); ADMIN and MENTOR keep their names and carry over.
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('MEMBER', 'LEAD', 'TECHNICAL_DIRECTOR', 'SOCIAL_DIRECTOR', 'PRESIDENT', 'VICE_PRESIDENT', 'MENTOR', 'ADMIN');
ALTER TABLE "public"."Member" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "Member" ALTER COLUMN "role" TYPE "Role_new" USING (
    CASE "role"::text WHEN 'STUDENT' THEN 'MEMBER' ELSE "role"::text END
)::"Role_new";
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "public"."Role_old";
ALTER TABLE "Member" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
COMMIT;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "subteam" "Subteam",
ALTER COLUMN "role" SET DEFAULT 'MEMBER';
