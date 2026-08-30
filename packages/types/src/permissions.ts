import { z } from "zod";

import { toolKeySchema } from "./tools";

// Authorization is decided at CRUD granularity. These four names are the only
// vocabulary; a route asks for exactly one of them.
export const permissionActionSchema = z.enum(["read", "create", "update", "delete"]);

// What a role grants on one tool. The four flags are independent on purpose:
// "can create but not delete" is the normal shape of a member's permissions,
// not an edge case.
export const permissionSetSchema = z.object({
  canRead: z.boolean(),
  canCreate: z.boolean(),
  canUpdate: z.boolean(),
  canDelete: z.boolean(),
});

export const rolePermissionSchema = permissionSetSchema.extend({
  toolId: z.string(),
  tool: toolKeySchema.optional(),
});

// The whole matrix for one role, sent and stored as a set. There is no
// endpoint that flips a single flag: the matrix is small, and replacing it
// whole means a client never has to reason about a half-applied change.
export const rolePermissionMatrixSchema = z.object({
  permissions: z
    .array(permissionSetSchema.extend({ tool: toolKeySchema }))
    .superRefine((entries, ctx) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        if (seen.has(entry.tool)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "tool"],
            message: "Bu modul zaten listede var",
          });
        }
        seen.add(entry.tool);
      });
    }),
});

export const EMPTY_PERMISSIONS: PermissionSet = {
  canRead: false,
  canCreate: false,
  canUpdate: false,
  canDelete: false,
};

/** Maps an action onto the flag that grants it. */
export const PERMISSION_FLAG: Record<PermissionAction, keyof PermissionSet> = {
  read: "canRead",
  create: "canCreate",
  update: "canUpdate",
  delete: "canDelete",
};

/**
 * Merges permission sets by OR. Holding two roles can only ever add
 * permissions, never take one away -- so a lead who is also a member of another
 * department does not lose anything by being both.
 */
export function mergePermissions(sets: readonly PermissionSet[]): PermissionSet {
  return sets.reduce<PermissionSet>(
    (merged, set) => ({
      canRead: merged.canRead || set.canRead,
      canCreate: merged.canCreate || set.canCreate,
      canUpdate: merged.canUpdate || set.canUpdate,
      canDelete: merged.canDelete || set.canDelete,
    }),
    { ...EMPTY_PERMISSIONS }
  );
}

export type PermissionAction = z.infer<typeof permissionActionSchema>;
export type PermissionSet = z.infer<typeof permissionSetSchema>;
export type RolePermission = z.infer<typeof rolePermissionSchema>;
export type RolePermissionMatrixInput = z.infer<typeof rolePermissionMatrixSchema>;
