import type { PrismaClient } from "@breakpoint/db";

import { ConflictError } from "../../lib/http-errors";
import type { CreateToolInput, UpdateToolInput } from "./tools.schema";

const toolSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  isActive: true,
} as const;

// TOOLS is not a module like the others: it is the catalogue that every
// authorize() call for every other module reads through, and it is also what
// gates its own route (see tools.routes.ts). Turning it off leaves nothing
// that can turn it back on -- PATCH and DELETE both need requirePlatform() and
// authorize({tool:"TOOLS"}) to pass first, and authorize() refuses any request
// for a tool whose own row is inactive, itself included. There is deliberately
// no such trap for any other module: this is the one row the API must never
// let go inactive.
const CATALOGUE_TOOL_KEY = "TOOLS";

export function createToolsService(prisma: PrismaClient) {
  return {
    // Not paginated: there are thirteen of these and there will not be many
    // more. An endpoint that can only ever return one page does not need the
    // envelope.
    list: () => prisma.tool.findMany({ select: toolSelect, orderBy: { key: "asc" } }),

    getById: (id: string) => prisma.tool.findUnique({ where: { id }, select: toolSelect }),

    create: (input: CreateToolInput) => prisma.tool.create({ data: input, select: toolSelect }),

    async update(id: string, input: UpdateToolInput) {
      if (input.isActive === false) {
        const tool = await prisma.tool.findUnique({ where: { id }, select: { key: true } });
        if (tool?.key === CATALOGUE_TOOL_KEY) {
          throw new ConflictError("TOOLS modulu pasife alinamaz");
        }
      }

      return prisma.tool.update({ where: { id }, data: input, select: toolSelect });
    },

    /**
     * Deactivates rather than deletes. A deleted tool would cascade its
     * RolePermission and GroupTool rows away, so turning a module off for a
     * week and back on would silently wipe every permission anyone had on it.
     * isActive stops the tool at step 1 of authorize() and leaves the grants
     * intact.
     */
    async deactivate(id: string) {
      const tool = await prisma.tool.findUnique({ where: { id }, select: { key: true } });
      if (tool?.key === CATALOGUE_TOOL_KEY) {
        throw new ConflictError("TOOLS modulu pasife alinamaz");
      }

      return prisma.tool.update({ where: { id }, data: { isActive: false }, select: toolSelect });
    },
  };
}
