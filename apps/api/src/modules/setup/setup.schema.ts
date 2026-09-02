import { z } from "zod";
import { teamSetupStageSchema } from "@breakpoint/types";

// Moving backwards is by name, forwards is not: you may return to a finished
// step to change something, but "next" is the only way onwards, so that the
// server decides what next means and the client cannot skip a prerequisite.
export const goToStageSchema = z.object({ stage: teamSetupStageSchema });

// The NAMING step: what the team is actually called, and the season everything
// will hang off. Both are asked for together because a team with no season
// lands on a dashboard where nothing can be created.
export const namingSchema = z
  .object({
    name: z.string().min(1, "Takim adi gerekli").max(120),
    seasonName: z.string().min(1, "Sezon adi gerekli").max(80),
    seasonStartDate: z.coerce.date(),
    seasonEndDate: z.coerce.date(),
  })
  .refine((value) => value.seasonEndDate > value.seasonStartDate, {
    message: "Sezon bitisi baslangicindan sonra olmali",
    path: ["seasonEndDate"],
  });

export type GoToStageInput = z.infer<typeof goToStageSchema>;
export type NamingInput = z.infer<typeof namingSchema>;
