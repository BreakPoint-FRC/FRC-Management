-- Second half of the two-step from 20260831090200. Nothing reads either column
-- any more, so they go.
--
-- "scope" was replaced by "placement", which can say what scope could not.
--
-- "hierarchyLevel" is removed rather than replaced. It was display ordering and
-- authorization never read it -- who outranks whom has always been the
-- RoleHierarchy graph, walked to arbitrary depth, which is also what makes the
-- hierarchy transitive: an edge 1->2 and an edge 2->3 already put 1 above 3
-- without anyone storing a rank. Keeping a number beside the graph meant two
-- sources of truth for the same fact, and only one of them had edges to walk.
-- Display order is now derived from those edges (sortRolesByHierarchy in
-- packages/types/src/roles.ts).

DROP INDEX "Role_hierarchyLevel_idx";
ALTER TABLE "Role" DROP COLUMN "hierarchyLevel";
ALTER TABLE "Role" DROP COLUMN "scope";
DROP TYPE "RoleScope";
