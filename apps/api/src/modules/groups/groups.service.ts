import type { Prisma, PrismaClient } from "@breakpoint/db";

import { ConflictError } from "../../lib/http-errors";
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
  name: true,
  description: true,
  isActive: true,
  tools: { select: { toolId: true, isEnabled: true, tool: { select: { key: true } } } },
  _count: { select: { memberships: { where: { isActive: true } } } },
} satisfies Prisma.GroupSelect;

type GroupRow = Prisma.GroupGetPayload<{ select: typeof groupSelect }>;

function serialize(group: GroupRow) {
  const { tools, _count, ...rest } = group;
  return {
    ...rest,
    memberCount: _count.memberships,
    tools: tools.map((entry) => ({
      toolId: entry.toolId,
      tool: entry.tool.key,
      isEnabled: entry.isEnabled,
    })),
  };
}

export function createGroupsService(prisma: PrismaClient) {
  return {
    list: async (query: ListGroupsQuery) => {
      const where: Prisma.GroupWhereInput = query.includeInactive ? {} : { isActive: true };

      const [rows, total] = await prisma.$transaction([
        prisma.group.findMany({
          where,
          select: groupSelect,
          orderBy: { name: "asc" },
          ...toPrismaPage(query),
        }),
        prisma.group.count({ where }),
      ]);

      return paginated(rows.map(serialize), total, query);
    },

    getById: async (id: string) => {
      const group = await prisma.group.findUnique({ where: { id }, select: groupSelect });
      return group && serialize(group);
    },

    members: async (groupId: string) =>
      prisma.groupMembership.findMany({
        where: { groupId, isActive: true },
        select: {
          joinedAt: true,
          account: { select: { id: true, fullName: true, email: true, archivedAt: true } },
        },
        orderBy: { account: { fullName: "asc" } },
      }),

    create: async (input: CreateGroupInput) => {
      const group = await prisma.group.create({ data: input, select: groupSelect });
      return serialize(group);
    },

    update: async (id: string, input: UpdateGroupInput) => {
      const group = await prisma.group.update({ where: { id }, data: input, select: groupSelect });
      return serialize(group);
    },

    /**
     * Deactivates rather than deletes.
     *
     * Tasks, meetings and transactions reference a group with ON DELETE
     * RESTRICT, so a hard delete would fail as soon as the department had done
     * any work -- which is every department that has ever been used. Retiring
     * it keeps the history readable and takes it out of the pickers.
     */
    deactivate: async (id: string) => {
      // A group nobody can act in but that still grants roles is a confusing
      // half-state, so the roles go too. Memberships stay: who was in the
      // department is history.
      await prisma.$transaction([
        prisma.group.update({ where: { id }, data: { isActive: false } }),
        prisma.accountRole.updateMany({ where: { groupId: id }, data: { isActive: false } }),
      ]);
    },

    replaceTools: async (groupId: string, input: ReplaceGroupToolsInput) => {
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
     * Removing someone who still holds a role in the group is refused rather
     * than silently allowed: authorize() checks membership before it checks
     * roles, so the role would survive as a permission nobody can exercise, and
     * the department would look correctly configured while not working. Take
     * the role away first.
     */
    replaceMembers: async (groupId: string, input: ReplaceMembersInput) => {
      const keep = new Set(input.accountIds);

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
