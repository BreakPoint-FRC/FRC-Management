import type { Prisma, PrismaClient } from "@breakpoint/db";
import {
  expandGroupSubtrees,
  groupAncestorPath,
  wouldCreateGroupCycle,
} from "@breakpoint/types";

import { ConflictError, NotFoundError } from "../../lib/http-errors";
import { paginated, toPrismaPage } from "../../lib/pagination";
import type {
  CreateGroupInput,
  ListGroupsQuery,
  ReplaceGroupToolsInput,
  ReplaceMembersInput,
  UpdateGroupInput,
} from "./groups.schema";

const groupSelect = {
  id: true,
  parentId: true,
  name: true,
  description: true,
  isActive: true,
  tools: { select: { toolId: true, isEnabled: true, tool: { select: { key: true } } } },
  _count: { select: { memberships: { where: { isActive: true } } } },
} satisfies Prisma.GroupSelect;

type GroupRow = Prisma.GroupGetPayload<{ select: typeof groupSelect }>;

/**
 * `tools` is what this group states for itself; `effectiveTools` is what
 * actually applies once inheritance is resolved.
 *
 * The screen needs both. Showing only the effective set would make a row look
 * locally configured when it is really borrowing the answer from three levels
 * up, and the person switching a tool off has to know which of the two they are
 * about to change.
 */
function serialize(group: GroupRow, effective: Map<string, { isEnabled: boolean; from: string }>) {
  const { tools, _count, ...rest } = group;
  return {
    ...rest,
    memberCount: _count.memberships,
    tools: tools.map((entry) => ({
      toolId: entry.toolId,
      tool: entry.tool.key,
      isEnabled: entry.isEnabled,
    })),
    effectiveTools: [...effective].map(([tool, state]) => ({
      tool,
      isEnabled: state.isEnabled,
      // The group the answer came from. Equal to this group when it states its
      // own; an ancestor id when it is inherited.
      inheritedFrom: state.from === group.id ? null : state.from,
    })),
  };
}

export function createGroupsService(prisma: PrismaClient) {
  /** The whole team tree, which every tree operation below needs. */
  const treeOf = (teamId: string) =>
    prisma.group.findMany({ where: { teamId }, select: { id: true, parentId: true } });

  /**
   * Resolves the inherited tool state for one group.
   *
   * The nearest ancestor that states an answer wins, so switching MEETINGS on
   * for Teknik switches it on for Tasarim underneath, and Tasarim can still
   * write its own row to turn it back off. No row anywhere is a no -- absence
   * is the safe reading, and it is what authorize() reads too.
   */
  const effectiveToolsFor = async (
    teamId: string,
    groupId: string
  ): Promise<Map<string, { isEnabled: boolean; from: string }>> => {
    const [tree, rows] = await Promise.all([
      treeOf(teamId),
      prisma.groupTool.findMany({
        where: { group: { teamId } },
        select: { groupId: true, isEnabled: true, tool: { select: { key: true } } },
      }),
    ]);

    const stated = new Map<string, { isEnabled: boolean }>();
    for (const row of rows) stated.set(`${row.groupId}:${row.tool.key}`, row);

    const path = groupAncestorPath(groupId, tree);
    const resolved = new Map<string, { isEnabled: boolean; from: string }>();

    for (const key of new Set(rows.map((row) => row.tool.key))) {
      for (const ancestor of path) {
        const row = stated.get(`${ancestor}:${key}`);
        if (row) {
          resolved.set(key, { isEnabled: row.isEnabled, from: ancestor });
          break;
        }
      }
    }

    return resolved;
  };

  /** 404 unless the group exists and belongs to this team. */
  const assertInTeam = async (teamId: string, groupId: string) => {
    const found = await prisma.group.count({ where: { id: groupId, teamId } });
    if (found === 0) throw new NotFoundError("Grup bulunamadi");
  };

  /**
   * A parent has to be in the same team, and cannot be the group itself or one
   * of its own descendants.
   *
   * Prisma can express neither a CHECK nor a recursive assertion, and adding
   * one by hand puts the database permanently out of sync with schema.prisma
   * (docs/migrations.md), so this is where the rule lives. A cycle would not be
   * merely bad data: authorize() expands group subtrees on every scoped
   * request, so a loop is a hung request.
   */
  const assertParent = async (teamId: string, groupId: string | null, parentId: string | null) => {
    if (!parentId) return;
    await assertInTeam(teamId, parentId);
    if (!groupId) return;

    if (wouldCreateGroupCycle(groupId, parentId, await treeOf(teamId))) {
      throw new ConflictError("Bu ust grup secimi grup agacinda dongu olusturur");
    }
  };

  return {
    list: async (teamId: string, query: ListGroupsQuery) => {
      const where: Prisma.GroupWhereInput = {
        teamId,
        ...(query.includeInactive ? {} : { isActive: true }),
      };

      const [rows, total] = await prisma.$transaction([
        prisma.group.findMany({
          where,
          select: groupSelect,
          orderBy: { name: "asc" },
          ...toPrismaPage(query),
        }),
        prisma.group.count({ where }),
      ]);

      // Resolved once for the page rather than per row: the tree and the tool
      // rows are the same for all of them.
      const [tree, toolRows] = await Promise.all([
        treeOf(teamId),
        prisma.groupTool.findMany({
          where: { group: { teamId } },
          select: { groupId: true, isEnabled: true, tool: { select: { key: true } } },
        }),
      ]);
      const stated = new Map(
        toolRows.map((row) => [`${row.groupId}:${row.tool.key}`, row.isEnabled])
      );
      const toolKeys = [...new Set(toolRows.map((row) => row.tool.key))];

      const serialized = rows.map((group) => {
        const path = groupAncestorPath(group.id, tree);
        const effective = new Map<string, { isEnabled: boolean; from: string }>();
        for (const key of toolKeys) {
          for (const ancestor of path) {
            const isEnabled = stated.get(`${ancestor}:${key}`);
            if (isEnabled !== undefined) {
              effective.set(key, { isEnabled, from: ancestor });
              break;
            }
          }
        }
        return serialize(group, effective);
      });

      return paginated(serialized, total, query);
    },

    /**
     * The whole tree in one call, for the setup wizard and parent pickers.
     *
     * Live groups only unless asked otherwise. Both callers are choosing a
     * place to put something, and a retired department is not a place -- a tree
     * that still listed one would redraw a group the moment after someone
     * deleted it, which reads as the delete having failed.
     */
    tree: async (teamId: string, includeInactive = false) =>
      prisma.group.findMany({
        where: { teamId, ...(includeInactive ? {} : { isActive: true }) },
        select: { id: true, parentId: true, name: true, description: true, isActive: true },
        orderBy: { name: "asc" },
      }),

    getById: async (teamId: string, id: string) => {
      const group = await prisma.group.findFirst({ where: { id, teamId }, select: groupSelect });
      if (!group) return null;
      return serialize(group, await effectiveToolsFor(teamId, id));
    },

    members: async (teamId: string, groupId: string) => {
      await assertInTeam(teamId, groupId);
      return prisma.groupMembership.findMany({
        where: { groupId, isActive: true },
        select: {
          joinedAt: true,
          account: { select: { id: true, fullName: true, email: true, archivedAt: true } },
        },
        orderBy: { account: { fullName: "asc" } },
      });
    },

    create: async (teamId: string, input: CreateGroupInput) => {
      const parentId = input.parentId ?? null;
      await assertParent(teamId, null, parentId);

      const group = await prisma.group.create({
        data: { ...input, parentId, teamId },
        select: groupSelect,
      });
      return serialize(group, await effectiveToolsFor(teamId, group.id));
    },

    update: async (teamId: string, id: string, input: UpdateGroupInput) => {
      await assertInTeam(teamId, id);
      if (input.parentId !== undefined) {
        await assertParent(teamId, id, input.parentId ?? null);
      }

      const group = await prisma.group.update({
        where: { id },
        data: { ...input, ...(input.parentId !== undefined ? { parentId: input.parentId ?? null } : {}) },
        select: groupSelect,
      });
      return serialize(group, await effectiveToolsFor(teamId, id));
    },

    /**
     * Removes a department and everything under it -- really, when there is
     * nothing to preserve; by retiring it, when there is.
     *
     * Tasks, meetings, gantt boards and transactions reference a group with
     * ON DELETE RESTRICT, and that is the whole reason retiring exists: a
     * department that has done work is history, and a hard delete would either
     * fail or take the record of that work with it.
     *
     * But a group that has done no work is not history. It is usually a typo
     * made a minute ago during setup, and retiring it leaves a tombstone the
     * team can never clear -- invisible in the pickers, still holding its name
     * against `@@unique([teamId, name])`, so re-creating "Elektronik" after
     * deleting "Elektronik" answers 409. Soft-deleting something with no past
     * is all of the cost of history and none of the benefit.
     *
     * Either way the subtree goes with it: a live Tasarim under a removed
     * Mekanik is a department nobody can reach through the tree and nobody
     * meant to keep.
     */
    remove: async (teamId: string, id: string) => {
      await assertInTeam(teamId, id);
      const tree = await treeOf(teamId);
      const subtree = [...expandGroupSubtrees([id], tree)];

      const [meetings, tasks, boards, transactions] = await Promise.all([
        prisma.meeting.count({ where: { groupId: { in: subtree } } }),
        prisma.task.count({ where: { groupId: { in: subtree } } }),
        prisma.ganttBoard.count({ where: { groupId: { in: subtree } } }),
        prisma.financeTransaction.count({ where: { groupId: { in: subtree } } }),
      ]);
      const records = meetings + tasks + boards + transactions;

      if (records === 0) {
        // Memberships, role assignments, role scopes and tool rows all cascade
        // from Group, so nothing is left pointing at a row that is gone.
        //
        // Deepest first: Group.parentId is RESTRICT, so deleting a parent while
        // its child still exists is refused. deleteMany gives no order
        // guarantee, which is why this walks the levels itself.
        const depthOf = (groupId: string) => groupAncestorPath(groupId, tree).length;
        const deepestFirst = [...subtree].sort((a, b) => depthOf(b) - depthOf(a));

        await prisma.$transaction(
          deepestFirst.map((groupId) => prisma.group.delete({ where: { id: groupId } }))
        );

        return { removed: subtree.length, retired: 0 };
      }

      // A group nobody can act in but that still grants roles is a confusing
      // half-state, so the roles go too. Memberships stay: who was in the
      // department is history, which is exactly what this branch is preserving.
      await prisma.$transaction([
        prisma.group.updateMany({ where: { id: { in: subtree } }, data: { isActive: false } }),
        prisma.accountRole.updateMany({
          where: { groupId: { in: subtree } },
          data: { isActive: false },
        }),
      ]);

      return { removed: 0, retired: subtree.length };
    },

    /**
     * Replaces what this group states about its own tools.
     *
     * Whole-set, like every other assignment here: a tool left out states
     * nothing, which is not the same as stating "off". Stating nothing lets the
     * answer fall through to the parent; stating false stops it. That is the
     * whole of the override mechanism, and it is why an entry carries an
     * isEnabled rather than the list being a set of enabled keys.
     */
    replaceTools: async (teamId: string, groupId: string, input: ReplaceGroupToolsInput) => {
      await assertInTeam(teamId, groupId);

      const tools = await prisma.tool.findMany({
        where: { key: { in: input.tools.map((entry) => entry.tool) } },
        select: { id: true, key: true },
      });
      const idByKey = new Map(tools.map((tool) => [tool.key, tool.id]));

      await prisma.$transaction([
        prisma.groupTool.deleteMany({ where: { groupId } }),
        prisma.groupTool.createMany({
          data: input.tools.map((entry) => ({
            groupId,
            toolId: idByKey.get(entry.tool) as string,
            isEnabled: entry.isEnabled,
          })),
        }),
      ]);
    },

    /**
     * Replaces the member list.
     *
     * Removing someone who still holds an IN_GROUP role here is refused rather
     * than silently allowed: authorize() requires membership before an IN_GROUP
     * role counts, so the role would survive as a permission nobody can
     * exercise and the department would look correctly configured while not
     * working. Take the role away first.
     *
     * Roles scoped over the group from above (MANAGES_GROUP, ABOVE_GROUPS) are
     * not membership and are not checked here -- a director never joins the
     * departments they oversee.
     */
    replaceMembers: async (teamId: string, groupId: string, input: ReplaceMembersInput) => {
      await assertInTeam(teamId, groupId);
      const keep = new Set(input.accountIds);

      // Accounts have to be this team's own. Without this an admin could add a
      // member of another team by pasting an id, and every group-scoped read
      // would then be open to them.
      if (keep.size > 0) {
        const found = await prisma.account.count({
          where: { id: { in: [...keep] }, teamId },
        });
        if (found !== keep.size) throw new NotFoundError("Hesap bulunamadi");
      }

      const roleHolders = await prisma.accountRole.findMany({
        where: { groupId, isActive: true, accountId: { notIn: [...keep] } },
        select: { account: { select: { fullName: true } } },
        distinct: ["accountId"],
      });

      if (roleHolders.length > 0) {
        const names = roleHolders.map((entry) => entry.account.fullName).join(", ");
        throw new ConflictError(
          `Bu grupta rolu olan uyeler cikarilamaz, once rollerini kaldirin: ${names}`
        );
      }

      await prisma.$transaction([
        prisma.groupMembership.updateMany({
          where: { groupId, accountId: { notIn: [...keep] } },
          data: { isActive: false },
        }),
        ...input.accountIds.map((accountId) =>
          prisma.groupMembership.upsert({
            where: { accountId_groupId: { accountId, groupId } },
            update: { isActive: true },
            create: { accountId, groupId },
          })
        ),
      ]);
    },
  };
}
