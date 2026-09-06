import type { Prisma, PrismaClient } from "@breakpoint/db";

import { paginated, toPrismaPage } from "../../lib/pagination";
import type { ListAuditLogQuery } from "./audit-log.schema";

const auditLogSelect = {
  id: true,
  teamId: true,
  actorId: true,
  entityType: true,
  entityId: true,
  action: true,
  oldValue: true,
  newValue: true,
  createdAt: true,
  actor: { select: { id: true, fullName: true } },
} satisfies Prisma.AuditLogSelect;

export function createAuditLogService(prisma: PrismaClient) {
  return {
    list: async (teamId: string, query: ListAuditLogQuery) => {
      // teamId is never accepted from the query. This predicate is the tenant
      // boundary and is shared by both the page and its count.
      const where: Prisma.AuditLogWhereInput = {
        teamId,
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: query.from } : {}),
                ...(query.to ? { lte: query.to } : {}),
              },
            }
          : {}),
      };

      const [items, total] = await prisma.$transaction([
        prisma.auditLog.findMany({
          where,
          select: auditLogSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...toPrismaPage(query),
        }),
        prisma.auditLog.count({ where }),
      ]);

      return paginated(items, total, query);
    },
  };
}
