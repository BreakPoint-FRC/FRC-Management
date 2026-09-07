import type { FastifyInstance } from "fastify";

import { authorize } from "../../lib/authorize";
import { requireTeam } from "../../lib/tenant";
import { listAuditLogQuerySchema } from "./audit-log.schema";
import { createAuditLogService } from "./audit-log.service";

/**
 * Mounted at /audit-log. This module is intentionally read-only: audit rows
 * are emitted by the transaction that changes the audited configuration.
 *
 * GET /audit-log ?entityType&entityId&from&to&page&pageSize
 */
export async function auditLogRoutes(app: FastifyInstance) {
  const service = createAuditLogService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "AUDIT_LOG",
      action: "read",
    });
    return service.list(requireTeam(req.account), listAuditLogQuerySchema.parse(req.query));
  });
}
