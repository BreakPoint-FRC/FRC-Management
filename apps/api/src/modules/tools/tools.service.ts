import type { PrismaClient } from "@breakpoint/db";

import type { CreateToolInput, UpdateToolInput } from "./tools.schema";

const toolSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  isActive: true,
} as const;

export function createToolsService(prisma: PrismaClient) {
  return {
    // Not paginated: there are thirteen of these and there will not be many
    // more. An endpoint that can only ever return one page does not need the
    // envelope.
    list: () => prisma.tool.findMany({ select: toolSelect, orderBy: { key: "asc" } }),

    getById: (id: string) => prisma.tool.findUnique({ where: { id }, select: toolSelect }),

    create: (input: CreateToolInput) => prisma.tool.create({ data: input, select: toolSelect }),

    update: (id: string, input: UpdateToolInput) =>
      prisma.tool.update({ where: { id }, data: input, select: toolSelect }),

    /**
     * Deactivates rather than deletes. A deleted tool would cascade its
     * RolePermission and GroupTool rows away, so turning a module off for a
     * week and back on would silently wipe every permission anyone had on it.
     * isActive stops the tool at step 1 of authorize() and leaves the grants
     * intact.
     */
    deactivate: (id: string) =>
      prisma.tool.update({ where: { id }, data: { isActive: false }, select: toolSelect }),
  };
}
