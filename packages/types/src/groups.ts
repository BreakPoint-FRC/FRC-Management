import { z } from "zod";

// A department, and now a node in a tree: Teknik > Mekanik > Tasarim. Rows
// rather than a fixed enum, so a team can add one without a migration, and
// nested rather than flat, because how finely a team subdivides itself is a
// decision for that team.
export const groupSchema = z.object({
  id: z.string(),
  // null for a root department. The depth below a root is not limited.
  parentId: z.string().nullable(),
  name: z.string().min(1),
  description: z.string().nullable(),
  isActive: z.boolean(),
});

// Membership is soft-ended with isActive rather than deleted: who was in which
// department during a season is history worth keeping.
export const groupMembershipSchema = z.object({
  accountId: z.string(),
  groupId: z.string(),
  joinedAt: z.coerce.date(),
  isActive: z.boolean(),
});

export type Group = z.infer<typeof groupSchema>;
export type GroupMembership = z.infer<typeof groupMembershipSchema>;

type GroupNode = { id: string; parentId: string | null };

/** childId -> parentId, for walking up. */
function parentIndex(groups: readonly GroupNode[]): Map<string, string | null> {
  return new Map(groups.map((group) => [group.id, group.parentId]));
}

/** parentId -> childIds, for walking down. */
export function groupChildIndex(groups: readonly GroupNode[]): Map<string, string[]> {
  const childrenOf = new Map<string, string[]>();
  for (const group of groups) {
    if (group.parentId === null) continue;
    const children = childrenOf.get(group.parentId);
    if (children) children.push(group.id);
    else childrenOf.set(group.parentId, [group.id]);
  }
  return childrenOf;
}

/**
 * Every group at or below the given roots.
 *
 * This is what turns "the Technical Director is scoped to Teknik" into actual
 * coverage of Mekanik and Tasarim underneath it. RoleGroupScope stores only the
 * roots; the closure is computed here on every read, so adding a subgroup
 * extends the authority of the roles above it without rewriting a single row.
 *
 * The visited set doubles as a cycle guard. groups.service rejects cycles on
 * the write path, but this runs inside authorize() on every request and a loop
 * here would be a hung request rather than a wrong answer.
 */
export function expandGroupSubtrees(
  rootIds: Iterable<string>,
  groups: readonly GroupNode[]
): Set<string> {
  const childrenOf = groupChildIndex(groups);
  const covered = new Set(rootIds);
  const queue = [...covered];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (!covered.has(child)) {
        covered.add(child);
        queue.push(child);
      }
    }
  }

  return covered;
}

/**
 * A group and everything above it, nearest parent first.
 *
 * Used to resolve an inherited GroupTool row: walk up until a group states an
 * answer for the tool, and take the first one found.
 */
export function groupAncestorPath(groupId: string, groups: readonly GroupNode[]): string[] {
  const parentOf = parentIndex(groups);
  const path: string[] = [groupId];
  const seen = new Set(path);

  let current = parentOf.get(groupId) ?? null;
  while (current !== null && !seen.has(current)) {
    path.push(current);
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }

  return path;
}

/**
 * Would making `parentId` the parent of `groupId` close a loop?
 *
 * A group cannot be its own ancestor. Prisma can express neither a CHECK nor a
 * recursive assertion, so this is the check groups.service runs before writing
 * -- see docs/migrations.md for why a hand-written constraint is not an option.
 */
export function wouldCreateGroupCycle(
  groupId: string,
  parentId: string | null,
  groups: readonly GroupNode[]
): boolean {
  if (parentId === null) return false;
  if (parentId === groupId) return true;
  return groupAncestorPath(parentId, groups).includes(groupId);
}

/**
 * Depth-first order with a depth for each row, for rendering the tree as an
 * indented list -- a <select> of parents, the wizard editor, the tools screen.
 *
 * Siblings are sorted by name so the order does not depend on insertion.
 */
export function flattenGroupTree<T extends GroupNode & { name: string }>(
  groups: readonly T[]
): Array<{ group: T; depth: number }> {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const childrenOf = groupChildIndex(groups);
  const byName = (a: string, b: string) =>
    (byId.get(a)?.name ?? "").localeCompare(byId.get(b)?.name ?? "");

  const out: Array<{ group: T; depth: number }> = [];
  const seen = new Set<string>();

  const walk = (id: string, depth: number) => {
    const group = byId.get(id);
    if (!group || seen.has(id)) return;
    seen.add(id);
    out.push({ group, depth });
    for (const child of [...(childrenOf.get(id) ?? [])].sort(byName)) walk(child, depth + 1);
  };

  const roots = groups
    .filter((group) => group.parentId === null || !byId.has(group.parentId))
    .map((group) => group.id)
    .sort(byName);
  for (const root of roots) walk(root, 0);

  // A group orphaned by a cycle would otherwise vanish from the screen that is
  // supposed to let someone fix it.
  for (const group of groups) if (!seen.has(group.id)) out.push({ group, depth: 0 });

  return out;
}
