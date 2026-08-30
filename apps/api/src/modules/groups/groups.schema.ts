import { z } from "zod";
import { paginationSchema, toolKeySchema } from "@breakpoint/types";

const groupFields = z.object({
  name: z.string().min(1, "Grup adi gerekli").max(80),
  description: z.string().max(500).nullish(),
  isActive: z.boolean().default(true),
});

export const createGroupSchema = groupFields;
export const updateGroupSchema = groupFields.partial();

export const listGroupsQuerySchema = paginationSchema.extend({
  includeInactive: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true")
    .default(false),
});

// The whole tool set for a group, replaced at once. A tool left out of the list
// is off -- which is the same thing a missing row means to authorize(), so the
// request and the check agree on what absence signifies.
export const replaceGroupToolsSchema = z.object({
  tools: z
    .array(z.object({ tool: toolKeySchema, isEnabled: z.boolean().default(true) }))
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

export const replaceMembersSchema = z.object({
  accountIds: z.array(z.string().min(1)).superRefine((ids, ctx) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Bu uye zaten listede var",
        });
      }
      seen.add(id);
    });
  }),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type ListGroupsQuery = z.infer<typeof listGroupsQuerySchema>;
export type ReplaceGroupToolsInput = z.infer<typeof replaceGroupToolsSchema>;
export type ReplaceMembersInput = z.infer<typeof replaceMembersSchema>;
