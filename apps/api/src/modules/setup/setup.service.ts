import type { PrismaClient } from "@breakpoint/db";
import {
  TEAM_SETUP_STAGES,
  nextSetupStage,
  slugifyTeamName,
  type TeamSetupStage,
} from "@breakpoint/types";

import { ConflictError, NotFoundError } from "../../lib/http-errors";
import type { NamingInput } from "./setup.schema";
import { FRC_ROLE_TEMPLATE, parseGrant } from "./setup.template";

/**
 * What each step needs before the next one can start.
 *
 * These are dependencies rather than preferences. A role cannot be scoped to a
 * group that does not exist; a permission cannot be granted on a tool no group
 * uses; and a team with no season lands on a dashboard where nothing can be
 * created, which is why NAMING asks for one.
 *
 * Steps not listed here have no prerequisite -- the wizard does not insist a
 * team invent roles it does not want.
 */
const STAGE_REQUIREMENT: Partial<Record<TeamSetupStage, string>> = {
  GROUPS: "En az bir grup olusturun",
  NAMING: "Takim adi ve bir sezon gerekli",
};

export function createSetupService(prisma: PrismaClient) {
  const teamOrThrow = async (teamId: string) => {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        name: true,
        slug: true,
        isActive: true,
        setupStage: true,
        setupCompletedAt: true,
      },
    });
    if (!team) throw new NotFoundError("Takim bulunamadi");
    return team;
  };

  /** Counts the wizard reports back, so each step can show what it has done. */
  const progressOf = async (teamId: string) => {
    const [groups, roles, groupTools, permissions, accounts, seasons] = await Promise.all([
      // Live groups only: a retired one cannot be scoped to, assigned a module
      // or joined, so counting it would let the step be left with nothing usable.
      prisma.group.count({ where: { teamId, isActive: true } }),
      prisma.role.count({ where: { teamId, isSystemRole: false } }),
      prisma.groupTool.count({ where: { group: { teamId } } }),
      prisma.rolePermission.count({ where: { role: { teamId, isSystemRole: false } } }),
      prisma.account.count({ where: { teamId, archivedAt: null } }),
      prisma.season.count({ where: { teamId } }),
    ]);
    return { groups, roles, groupTools, permissions, accounts, seasons };
  };

  /**
   * Whether the current step is satisfied.
   *
   * Returns the reason rather than a boolean so the screen can say what is
   * missing instead of greying out a button with no explanation.
   */
  const blockerFor = async (
    teamId: string,
    stage: TeamSetupStage
  ): Promise<string | null> => {
    const progress = await progressOf(teamId);
    if (stage === "GROUPS" && progress.groups === 0) {
      return STAGE_REQUIREMENT.GROUPS as string;
    }
    if (stage === "NAMING") {
      const team = await teamOrThrow(teamId);
      // The draft name a system admin typed is not an answer to "what is this
      // team called" -- the step exists to replace it, and a season has to
      // exist before the dashboard is worth landing on.
      if (progress.seasons === 0 || team.name.trim().length === 0) {
        return STAGE_REQUIREMENT.NAMING as string;
      }
    }
    return null;
  };

  return {
    state: async (teamId: string) => {
      const team = await teamOrThrow(teamId);
      const stage = team.setupStage as TeamSetupStage;
      return {
        team,
        stage,
        stages: TEAM_SETUP_STAGES,
        progress: await progressOf(teamId),
        blocker: await blockerFor(teamId, stage),
      };
    },

    /**
     * Moves to the next step, refusing when this one is not finished.
     *
     * Forwards only, and one at a time. Letting a client name the destination
     * would let it skip a prerequisite by asking for PERMISSIONS while no group
     * uses any tool.
     */
    advance: async (teamId: string) => {
      const team = await teamOrThrow(teamId);
      const stage = team.setupStage as TeamSetupStage;

      const blocker = await blockerFor(teamId, stage);
      if (blocker) throw new ConflictError(blocker);

      const next = nextSetupStage(stage);
      if (!next) throw new ConflictError("Kurulum zaten tamamlandi");

      return prisma.team.update({
        where: { id: teamId },
        data: {
          setupStage: next,
          // Reaching DONE is what ends the wizard; the timestamp is what the
          // dashboard redirect reads.
          ...(next === "DONE" ? { setupCompletedAt: new Date() } : {}),
        },
        select: { id: true, setupStage: true, setupCompletedAt: true },
      });
    },

    /**
     * Returns to a finished step.
     *
     * Only backwards. Going forward is `advance`, which checks prerequisites;
     * this one cannot skip anything because everything behind the current step
     * has already been through that check.
     */
    goBack: async (teamId: string, stage: TeamSetupStage) => {
      const team = await teamOrThrow(teamId);
      const current = TEAM_SETUP_STAGES.indexOf(team.setupStage as TeamSetupStage);
      const target = TEAM_SETUP_STAGES.indexOf(stage);

      if (target >= current) {
        throw new ConflictError("Sadece tamamlanmis bir adima geri donulebilir");
      }

      return prisma.team.update({
        where: { id: teamId },
        data: { setupStage: stage, setupCompletedAt: null },
        select: { id: true, setupStage: true, setupCompletedAt: true },
      });
    },

    /**
     * Writes the team name and its first season.
     *
     * The name is asked for here rather than at creation because the groups in
     * step one already needed a teamId to hang from -- the row had to exist
     * before there was a considered answer to what it is called.
     *
     * The season comes with it because every operational record hangs off one.
     * Without a season the team would finish the wizard and land on a dashboard
     * where no task, meeting or transaction can be created, and the error would
     * read as a bug rather than a missing step.
     */
    naming: async (teamId: string, input: NamingInput) => {
      await teamOrThrow(teamId);

      const slug = slugifyTeamName(input.name) || "takim";
      const taken = await prisma.team.count({
        where: { slug, id: { not: teamId } },
      });

      return prisma.$transaction(async (tx) => {
        const team = await tx.team.update({
          where: { id: teamId },
          data: { name: input.name, ...(taken === 0 ? { slug } : {}) },
          select: { id: true, name: true, slug: true, setupStage: true },
        });

        // Idempotent: running the step again renames the season rather than
        // adding a second one, because someone correcting a typo is the common
        // case and two seasons would both claim to be the first.
        const existing = await tx.season.findFirst({
          where: { teamId },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        });

        const season = existing
          ? await tx.season.update({
              where: { id: existing.id },
              data: {
                name: input.seasonName,
                startDate: input.seasonStartDate,
                endDate: input.seasonEndDate,
                isActive: true,
              },
              select: { id: true, name: true, startDate: true, endDate: true, isActive: true },
            })
          : await tx.season.create({
              data: {
                teamId,
                name: input.seasonName,
                startDate: input.seasonStartDate,
                endDate: input.seasonEndDate,
                isActive: true,
              },
              select: { id: true, name: true, startDate: true, endDate: true, isActive: true },
            });

        return { team, season };
      });
    },

    /**
     * Applies the starting role set.
     *
     * Offered rather than imposed, and only while the team has no roles of its
     * own: re-running it over an edited tree would undo the edits, and "apply a
     * template" is not what someone means when they press it a second time.
     *
     * MANAGES_GROUP roles in the template are created scoped to every root
     * group, which is the reading that matches "Grup Lideri" -- one lead role
     * covering each department rather than a role per department. The team
     * narrows it afterwards if that is not what they meant.
     */
    applyTemplate: async (teamId: string) => {
      const existing = await prisma.role.count({ where: { teamId, isSystemRole: false } });
      if (existing > 0) {
        throw new ConflictError(
          "Bu takimda zaten roller var, sablon uygulanamaz -- rolleri elle duzenleyin"
        );
      }

      const [groups, tools] = await Promise.all([
        prisma.group.findMany({ where: { teamId }, select: { id: true, parentId: true } }),
        prisma.tool.findMany({ select: { id: true, key: true } }),
      ]);
      if (groups.length === 0) {
        throw new ConflictError("Once gruplari olusturun");
      }

      const toolIdByKey = new Map(tools.map((tool) => [tool.key, tool.id]));
      const rootGroupIds = groups.filter((group) => group.parentId === null).map((g) => g.id);

      return prisma.$transaction(async (tx) => {
        const idByKey = new Map<string, string>();

        for (const template of FRC_ROLE_TEMPLATE) {
          const role = await tx.role.create({
            data: {
              teamId,
              key: template.key,
              name: template.name,
              description: template.description,
              placement: template.placement,
              isSystemRole: false,
              ...(template.placement === "MANAGES_GROUP"
                ? { groupScopes: { create: rootGroupIds.map((groupId) => ({ groupId })) } }
                : {}),
            },
            select: { id: true },
          });
          idByKey.set(template.key, role.id);

          const grants = Object.entries(template.grants)
            .map(([toolKey, letters]) => ({
              roleId: role.id,
              toolId: toolIdByKey.get(toolKey),
              ...parseGrant(letters),
            }))
            .filter((grant): grant is typeof grant & { toolId: string } => !!grant.toolId);
          if (grants.length > 0) await tx.rolePermission.createMany({ data: grants });
        }

        // Edges last, so every key in `above` already resolves to a row. The
        // template is acyclic by construction, which is why this does not need
        // the cycle walk roles.service does for edges a person types.
        const edges = FRC_ROLE_TEMPLATE.flatMap((template) =>
          template.above.map((childKey) => ({
            parentRoleId: idByKey.get(template.key) as string,
            childRoleId: idByKey.get(childKey) as string,
          }))
        ).filter((edge) => edge.parentRoleId && edge.childRoleId);
        if (edges.length > 0) await tx.roleHierarchy.createMany({ data: edges });

        return { created: idByKey.size, edges: edges.length };
      });
    },
  };
}
