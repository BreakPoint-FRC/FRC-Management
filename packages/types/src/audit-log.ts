import { z } from "zod";

/**
 * Stable vocabulary for the security audit trail.
 *
 * These are strings in PostgreSQL on purpose: the audit trail spans domains,
 * and adding the next audited action must not require altering a database enum.
 * The API still validates filters against this closed list, and audit writes
 * are server-internal, so clients cannot invent either value.
 */
export const AUDIT_ENTITY_TYPES = ["ACCOUNT", "ROLE", "GROUP", "TEAM"] as const;

export const AUDIT_ACTIONS = [
  "ACCOUNT_CREATED",
  "ACCOUNT_ROLES_REPLACED",
  "ROLE_CREATED",
  "ROLE_UPDATED",
  "ROLE_DELETED",
  "ROLE_PERMISSIONS_REPLACED",
  "ROLE_HIERARCHY_LINKED",
  "ROLE_HIERARCHY_UNLINKED",
  "GROUP_CREATED",
  "GROUP_PARENT_CHANGED",
  "GROUP_TOOLS_REPLACED",
  "GROUP_REMOVED",
  "GROUP_RETIRED",
  "TEMPLATE_APPLIED",
] as const;

export const auditEntityTypeSchema = z.enum(AUDIT_ENTITY_TYPES);
export const auditActionSchema = z.enum(AUDIT_ACTIONS);

export const auditLogSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  actorId: z.string(),
  actor: z.object({ id: z.string(), fullName: z.string() }),
  entityType: auditEntityTypeSchema,
  entityId: z.string(),
  action: auditActionSchema,
  oldValue: z.unknown().nullable(),
  newValue: z.unknown().nullable(),
  createdAt: z.coerce.date(),
});

export type AuditEntityType = z.infer<typeof auditEntityTypeSchema>;
export type AuditAction = z.infer<typeof auditActionSchema>;
export type AuditLog = z.infer<typeof auditLogSchema>;

/** Human-readable labels shared by every client that renders the audit trail. */
export const AUDIT_ENTITY_TYPE_LABELS: Record<AuditEntityType, string> = {
  ACCOUNT: "Hesap",
  ROLE: "Rol",
  GROUP: "Grup",
  TEAM: "Takım",
};

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  ACCOUNT_CREATED: "Hesap oluşturuldu",
  ACCOUNT_ROLES_REPLACED: "Hesap rolleri değiştirildi",
  ROLE_CREATED: "Rol oluşturuldu",
  ROLE_UPDATED: "Rol güncellendi",
  ROLE_DELETED: "Rol silindi",
  ROLE_PERMISSIONS_REPLACED: "Rol izinleri değiştirildi",
  ROLE_HIERARCHY_LINKED: "Rol bağlantısı eklendi",
  ROLE_HIERARCHY_UNLINKED: "Rol bağlantısı kaldırıldı",
  GROUP_CREATED: "Grup oluşturuldu",
  GROUP_PARENT_CHANGED: "Üst grup değiştirildi",
  GROUP_TOOLS_REPLACED: "Grup modülleri değiştirildi",
  GROUP_REMOVED: "Grup silindi",
  GROUP_RETIRED: "Grup emekliye ayrıldı",
  TEMPLATE_APPLIED: "Rol şablonu uygulandı",
};
