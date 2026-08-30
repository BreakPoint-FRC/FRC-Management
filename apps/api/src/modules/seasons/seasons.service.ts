import type { PrismaClient } from "@breakpoint/db";

import { ConflictError, NotFoundError } from "../../lib/http-errors";
import { paginated, toPrismaPage } from "../../lib/pagination";
import type { CreateSeasonInput, ListSeasonsQuery, UpdateSeasonInput } from "./seasons.schema";

const seasonSelect = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  isActive: true,
  _count: {
    select: { tasks: true, meetings: true, transactions: true, sponsorships: true },
  },
} as const;

export function createSeasonsService(prisma: PrismaClient) {
  /**
   * Makes one season the current one and no others.
   *
   * Enforced here rather than by a partial unique index, which Prisma cannot
   * express -- and it belongs here anyway: "the current season" is a decision
   * someone makes, not a shape the data has. Both writes are in one
   * transaction, so there is never a moment with two active seasons or none.
   */
  const activateExclusively = (id: string) => [
    prisma.season.updateMany({ where: { id: { not: id } }, data: { isActive: false } }),
    prisma.season.update({ where: { id }, data: { isActive: true } }),
  ];

  return {
    list: async (query: ListSeasonsQuery) => {
      const [rows, total] = await prisma.$transaction([
        prisma.season.findMany({
          select: seasonSelect,
          orderBy: { startDate: "desc" },
          ...toPrismaPage(query),
        }),
        prisma.season.count(),
      ]);

      return paginated(rows, total, query);
    },

    getById: (id: string) => prisma.season.findUnique({ where: { id }, select: seasonSelect }),

    /** The season new records default to. */
    current: () =>
      prisma.season.findFirst({ where: { isActive: true }, select: seasonSelect }),

    create: async ({ isActive, ...rest }: CreateSeasonInput) => {
      const season = await prisma.season.create({ data: rest, select: { id: true } });
      if (isActive) await prisma.$transaction(activateExclusively(season.id));

      return prisma.season.findUniqueOrThrow({ where: { id: season.id }, select: seasonSelect });
    },

    update: async (id: string, { isActive, ...rest }: UpdateSeasonInput) => {
      await prisma.season.update({ where: { id }, data: rest });

      // Only ever used to turn a season on. Turning the active season off would
      // leave no current season at all, and every "create a task" would have
      // nothing to attach to -- activate a different one instead.
      if (isActive === true) await prisma.$transaction(activateExclusively(id));

      return prisma.season.findUniqueOrThrow({ where: { id }, select: seasonSelect });
    },

    activate: async (id: string) => {
      await prisma.season.findUniqueOrThrow({ where: { id }, select: { id: true } });
      await prisma.$transaction(activateExclusively(id));
      return prisma.season.findUniqueOrThrow({ where: { id }, select: seasonSelect });
    },

    /**
     * Only an empty season can be deleted.
     *
     * Everything operational points at a season with ON DELETE RESTRICT, so the
     * database would refuse anyway -- but as a P2003 that reads "Referenced
     * record does not exist", which describes the opposite of what happened.
     * A season with records in it is history and stays.
     */
    remove: async (id: string) => {
      const season = await prisma.season.findUnique({ where: { id }, select: seasonSelect });
      if (!season) throw new NotFoundError("Sezon bulunamadi");

      const records =
        season._count.tasks +
        season._count.meetings +
        season._count.transactions +
        season._count.sponsorships;

      if (records > 0) {
        throw new ConflictError(
          `${season.name} sezonuna bagli ${records} kayit var, sezon silinemez`
        );
      }
      if (season.isActive) throw new ConflictError("Aktif sezon silinemez");

      await prisma.season.delete({ where: { id } });
    },
  };
}
