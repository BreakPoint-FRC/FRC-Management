import { auditEntityTypeSchema, paginationSchema } from "@breakpoint/types";
import { z } from "zod";

export const listAuditLogQuerySchema = paginationSchema
  .extend({
    entityType: auditEntityTypeSchema.optional(),
    entityId: z.string().min(1).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: "Baslangic tarihi bitis tarihinden sonra olamaz",
    path: ["to"],
  });

export type ListAuditLogQuery = z.infer<typeof listAuditLogQuerySchema>;
