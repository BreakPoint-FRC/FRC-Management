import { z } from "zod";

export const createGroupSchema = z.object({
  name: z.string().min(1),
});

// `.partial()` alone would accept `{}` and, because Zod strips unknown keys,
// also a typo like `{ groupName: "x" }` — both reach Prisma as an empty `data`
// and answer 200 with the row unchanged, so the caller believes a rename landed
// that never happened. Reject an update that changes nothing instead.
export const updateGroupSchema = createGroupSchema
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "Provide at least one field to update",
  });

export const addGroupMemberSchema = z.object({
  memberId: z.string().min(1),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type AddGroupMemberInput = z.infer<typeof addGroupMemberSchema>;
