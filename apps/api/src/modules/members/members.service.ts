import type { PrismaClient } from "@breakpoint/db";
import type { CreateMemberInput, UpdateMemberInput } from "./members.schema";

export function createMembersService(prisma: PrismaClient) {
  return {
    list: () => prisma.member.findMany(),

    getById: (id: string) => prisma.member.findUnique({ where: { id } }),

    create: (input: CreateMemberInput) => prisma.member.create({ data: input }),

    update: (id: string, input: UpdateMemberInput) =>
      prisma.member.update({ where: { id }, data: input }),

    // admin-only: "The Main Admin Should Be Able To Remove Users"
    remove: (id: string) => prisma.member.delete({ where: { id } }),
  };
}
