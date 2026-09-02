import type { PrismaClient } from "@breakpoint/db";

import { ConflictError, NotFoundError } from "./http-errors";

/**
 * The season a request is about, defaulting to the active one for that team.
 *
 * Every operational module needs this and four of them had grown their own
 * identical copy. Kept in one place so "there is no active season" is one
 * sentence to the user rather than four that drift apart, and so the day
 * seasons stop being a single active flag there is one function to change.
 *
 * It is also the tenant gate for every operational write. A named seasonId
 * comes from the request body, and a body is not to be trusted: without the
 * teamId filter here, naming another team's season would file this team's task
 * into it. Six modules would each have had to remember that check; this way
 * none of them can forget.
 *
 * Throws rather than falling back to the newest season: writing this year's
 * work into last year's records is worse than refusing, and the fix -- create a
 * season, or name one -- is a step the caller can actually take.
 */
export async function resolveSeasonId(
  prisma: PrismaClient,
  teamId: string,
  seasonId?: string
): Promise<string> {
  if (seasonId) {
    const named = await prisma.season.findFirst({
      where: { id: seasonId, teamId },
      select: { id: true },
    });
    // 404 rather than 403: a season of another team is not a permission
    // problem, it is a record this caller has no business knowing exists.
    if (!named) throw new NotFoundError("Sezon bulunamadi");
    return named.id;
  }

  const active = await prisma.season.findFirst({
    where: { teamId, isActive: true },
    select: { id: true },
  });

  if (!active) {
    throw new ConflictError("Aktif sezon yok, once bir sezon olusturun veya sezon secin");
  }

  return active.id;
}
