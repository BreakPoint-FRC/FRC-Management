import { z } from "zod";

// Where a team is in its first-run setup.
//
// The order is the order of the wizard screens and it is a dependency order,
// not a preference: a role cannot be scoped to a group that does not exist, and
// a permission cannot be granted on a tool the group does not use. Each step is
// written as it is completed, so closing the tab costs nothing.
export const teamSetupStageSchema = z.enum([
  "GROUPS",
  "ROLES",
  "TOOLS",
  "PERMISSIONS",
  "NAMING",
  "ACCOUNTS",
  "DONE",
]);

export type TeamSetupStage = z.infer<typeof teamSetupStageSchema>;

// In order. Used to decide what "the next step" is and to draw the progress
// rail, so the sequence lives here once rather than in the wizard component.
export const TEAM_SETUP_STAGES = teamSetupStageSchema.options;

export const TEAM_SETUP_STAGE_LABELS: Record<TeamSetupStage, string> = {
  GROUPS: "Gruplar",
  ROLES: "Roller",
  TOOLS: "Moduller",
  PERMISSIONS: "Izinler",
  NAMING: "Takim bilgileri",
  ACCOUNTS: "Hesaplar",
  DONE: "Tamamlandi",
};

export const TEAM_SETUP_STAGE_DESCRIPTIONS: Record<TeamSetupStage, string> = {
  GROUPS: "Gruplari ve alt gruplari kurun. Ornek: Teknik > Mekanik > Tasarim.",
  ROLES: "Rolleri tanimlayin, hangi gruplari kapsadiklarini ve birbirlerine bagliliklarini secin.",
  TOOLS: "Her gruba kullanacagi modulleri atayin. Alt gruplar ust gruptan devralir.",
  PERMISSIONS: "Her rolun her modulde ne yapabilecegini belirleyin.",
  NAMING: "Takimin adini ve ilk sezonunu girin.",
  ACCOUNTS: "Hesaplari acin ve rollerini atayin.",
  DONE: "Kurulum tamamlandi.",
};

/** The stage after this one, or null at the end. */
export function nextSetupStage(stage: TeamSetupStage): TeamSetupStage | null {
  const index = TEAM_SETUP_STAGES.indexOf(stage);
  return TEAM_SETUP_STAGES[index + 1] ?? null;
}

/**
 * Whether `stage` has been reached.
 *
 * The wizard lets you walk back into a finished step to change something, but
 * never forward past the one you are on -- a later step would be editing rows
 * that do not exist yet.
 */
export function isSetupStageReached(current: TeamSetupStage, stage: TeamSetupStage): boolean {
  return TEAM_SETUP_STAGES.indexOf(current) >= TEAM_SETUP_STAGES.indexOf(stage);
}

export const teamSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  slug: z.string().min(1),
  isActive: z.boolean(),
  setupStage: teamSetupStageSchema,
  setupCompletedAt: z.coerce.date().nullable(),
});

// A team is opened with a draft name and renamed at the NAMING step, because
// the groups created in step one already need a teamId to hang from. Only the
// admin name is required here -- everything else the team decides for itself.
export const createTeamSchema = z.object({
  name: z.string().min(1, "Takim adi gerekli").max(120),
  adminFullName: z.string().min(1, "Yonetici adi gerekli").max(120),
  adminEmail: z.string().email("Gecerli bir e-posta adresi girin"),
});

// Archiving is deliberately not a PATCH field. It has session and account
// consequences that belong to DELETE /teams/:id, and there is no inverse
// workflow yet that can safely decide which accounts and sessions to restore.
export const updateTeamSchema = z
  .object({
    name: z.string().min(1, "Takim adi gerekli").max(120),
  })
  .strict();

/**
 * A URL-safe slug from a team name.
 *
 * Turkish letters are folded to ASCII rather than dropped: "Çekirdek" has to
 * become "cekirdek" and not "ekirdek". Uniqueness is not this function's job --
 * teams.service appends a counter when the slug is taken.
 */
export function slugifyTeamName(name: string): string {
  const folded = name
    .replace(/[çÇ]/g, "c")
    .replace(/[ğĞ]/g, "g")
    .replace(/[ıİ]/g, "i")
    .replace(/[öÖ]/g, "o")
    .replace(/[şŞ]/g, "s")
    .replace(/[üÜ]/g, "u");
  return folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export type Team = z.infer<typeof teamSchema>;
export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
