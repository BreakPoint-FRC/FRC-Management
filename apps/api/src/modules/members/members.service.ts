import type { PrismaClient } from "@breakpoint/db";
import type { CreateMemberInput, UpdateMemberInput } from "./members.schema";

export function createMembersService(prisma: PrismaClient) {
  return {
    list: () => prisma.member.findMany({ where: { archivedAt: null } }),

    getById: (id: string) => prisma.member.findUnique({ where: { id } }),

    create: (input: CreateMemberInput) => prisma.member.create({ data: input }),

    update: (id: string, input: UpdateMemberInput) =>
      prisma.member.update({ where: { id }, data: input }),

    // Soft-delete members so attendance and group-membership history stays intact.
    // TODO: restrict to ADMIN role once auth is added.
    remove: (id: string) =>
      prisma.member.update({ where: { id }, data: { archivedAt: new Date() } }),
  };
}
