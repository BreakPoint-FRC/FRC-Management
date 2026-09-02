-- Groups become a tree: Teknik > Mekanik > Tasarim.
--
-- RESTRICT rather than CASCADE on the self-reference. Deleting a parent must not
-- silently take its children with it -- groups.service deactivates the subtree
-- explicitly instead, so the caller sees what they are about to switch off.
--
-- Nothing here stops a cycle. Prisma can express neither a CHECK nor a
-- recursive assertion, and hand-adding one puts the database permanently out of
-- sync with schema.prisma (docs/migrations.md), so groups.service walks the
-- ancestors before writing -- the same place roles.service guards
-- RoleHierarchy.

ALTER TABLE "Group" ADD COLUMN "parentId" TEXT;
CREATE INDEX "Group_parentId_idx" ON "Group"("parentId");
ALTER TABLE "Group" ADD CONSTRAINT "Group_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
