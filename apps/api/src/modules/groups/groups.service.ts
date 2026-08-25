import type { PrismaClient } from "@breakpoint/db";
import type {
  AddGroupMemberInput,
  CreateGroupInput,
  UpdateGroupInput,
} from "./groups.schema";

export function createGroupsService(prisma: PrismaClient) {
  return {
    list: () => prisma.group.findMany({ orderBy: { name: "asc" } }),

    // The detail view is what the two group-scoped roadmap items need: who is in
    // the group, and the tasks that belong to it. Archived members stay in the
    // membership list on purpose — a group's history should not change when
    // someone leaves the team.
    getById: (id: string) =>
      prisma.group.findUnique({
        where: { id },
        include: {
          members: { include: { member: true } },
          tasks: true,
        },
      }),

    create: (input: CreateGroupInput) => prisma.group.create({ data: input }),

    update: (id: string, input: UpdateGroupInput) =>
      prisma.group.update({ where: { id }, data: input }),

    // GroupMember.groupId is ON DELETE RESTRICT, so the join rows have to go
    // first or the delete fails with a foreign key error. Both statements run in
    // one transaction: a failed group delete (for example a group that does not
    // exist) must not leave the memberships already wiped.
    // Tasks are safe to leave alone — Task.groupId is ON DELETE SET NULL, so the
    // group's tasks survive as cross-group tasks instead of being deleted.
    remove: (id: string) =>
      prisma.$transaction([
        prisma.groupMember.deleteMany({ where: { groupId: id } }),
        prisma.group.delete({ where: { id } }),
      ]),

    // Members are soft-deleted (Member.archivedAt), so the foreign key cannot
    // catch an archived one: the row is still there. Without this lookup an
    // archived member is invisible in /members but can still be added to a
    // roster, and the group detail then lists someone the rest of the app
    // treats as gone. Members already in the group when they were archived stay
    // — that is history, not a new membership.
    findActiveMember: (memberId: string) =>
      prisma.member.findFirst({ where: { id: memberId, archivedAt: null } }),

    addMember: (groupId: string, input: AddGroupMemberInput) =>
      prisma.groupMember.create({
        data: { groupId, memberId: input.memberId },
      }),

    removeMember: (groupId: string, memberId: string) =>
      prisma.groupMember.delete({
        where: { groupId_memberId: { groupId, memberId } },
      }),
  };
}
