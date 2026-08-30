import type { PrismaClient } from "@breakpoint/db";

import { ConflictError } from "./http-errors";

/**
 * The season a request is about, defaulting to the active one.
 *
 * Every operational module needs this and four of them had grown their own
 * identical copy. Kept in one place so "there is no active season" is one
 * sentence to the user rather than four that drift apart, and so the day
 * seasons stop being a single active flag there is one function to change.
 *
 * Throws rather than falling back to the newest season: writing this year's
 * work into last year's records is worse than refusing, and the fix -- create a
 * season, or name one -- is a step the caller can actually take.
 */
export async function resolveSeasonId(
  prisma: PrismaClient,
  seasonId?: string
): Promise<string> {
  if (seasonId) return seasonId;

  const active = await prisma.season.findFirst({
    where: { isActive: true },
    select: { id: true },
  });

  if (!active) {
    throw new ConflictError("Aktif sezon yok, once bir sezon olusturun veya sezon secin");
  }

  return active.id;
}
