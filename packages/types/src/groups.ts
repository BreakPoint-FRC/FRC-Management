import { z } from "zod";

// A department: Programming, Mechanical, Electrical, Business, Media, Strategy.
// Rows rather than a fixed enum, so a team can add one without a migration.
export const groupSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().nullable(),
  isActive: z.boolean(),
});

// Membership is soft-ended with isActive rather than deleted: who was in which
// department during a season is history worth keeping.
export const groupMembershipSchema = z.object({
  accountId: z.string(),
  groupId: z.string(),
  joinedAt: z.coerce.date(),
  isActive: z.boolean(),
});

export type Group = z.infer<typeof groupSchema>;
export type GroupMembership = z.infer<typeof groupMembershipSchema>;
