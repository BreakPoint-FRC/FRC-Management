import { z } from "zod";

export const seasonSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  isActive: z.boolean(),
});

// Operational data hangs off a season so past records stay readable and never
// get mixed into the current season's totals. At most one season is active at a
// time; seasons.service enforces that, not a constraint, because "the current
// season" is a workflow decision rather than a shape.
export type Season = z.infer<typeof seasonSchema>;
