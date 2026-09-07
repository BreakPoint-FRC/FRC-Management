import type { Prisma } from "@breakpoint/db";
import type { AuditAction, AuditEntityType } from "@breakpoint/types";

export interface AuditWrite {
  teamId: string;
  actorId: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  oldValue?: Prisma.InputJsonValue | null;
  newValue?: Prisma.InputJsonValue | null;
}

/**
 * Writes through the caller's transaction only. Deliberately accepting a
 * TransactionClient (rather than PrismaClient) makes it impossible for a
 * service to accidentally commit the audit row separately from its mutation.
 */
export function writeAuditLog(tx: Prisma.TransactionClient, entry: AuditWrite) {
  return tx.auditLog.create({
    data: {
      teamId: entry.teamId,
      actorId: entry.actorId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      ...(entry.oldValue == null ? {} : { oldValue: entry.oldValue }),
      ...(entry.newValue == null ? {} : { newValue: entry.newValue }),
    },
  });
}

/** Values passed here are normalized and key-stable by their domain service. */
export function auditValuesEqual(left: Prisma.InputJsonValue, right: Prisma.InputJsonValue) {
  return JSON.stringify(left) === JSON.stringify(right);
}
