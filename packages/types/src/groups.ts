import { z } from "zod";
import { memberSchema } from "./members";
import { taskSchema } from "./tasks";

export const groupSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
});

// A membership is its own shape rather than a field on the group: the join row
// is the composite key (groupId, memberId), which is what the membership
// endpoints address.
export const groupMemberSchema = z.object({
  groupId: z.string(),
  memberId: z.string(),
});

// GET /groups/:id answers with the group plus its memberships (each carrying
// the whole member) and its tasks. Parsing that response with `groupSchema`
// would succeed and silently drop both arrays — Zod strips unknown keys — so
// the detail payload gets a schema of its own.
export const groupDetailSchema = groupSchema.extend({
  members: z.array(groupMemberSchema.extend({ member: memberSchema })),
  tasks: z.array(taskSchema),
});

export type Group = z.infer<typeof groupSchema>;
export type GroupMember = z.infer<typeof groupMemberSchema>;
export type GroupDetail = z.infer<typeof groupDetailSchema>;
