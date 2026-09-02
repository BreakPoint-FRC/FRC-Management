import type { PrismaClient } from "@breakpoint/db";
import type { AuthenticatedAccount } from "../plugins/auth";

import { ForbiddenError, NotFoundError } from "./http-errors";

/**
 * The team the request acts inside.
 *
 * Every team-scoped service takes a teamId and filters on it, and this is where
 * that id comes from: the authenticated account, never the request body.
 * Trusting the body would let anyone read another team by naming it.
 *
 * A platform system admin has no team, and that is not an oversight -- one that
 * sat inside a team would be a back door into it. Platform admins work through
 * /teams, which is scoped to nothing because it is about teams rather than
 * inside one.
 */
export function requireTeam(account: AuthenticatedAccount): string {
  if (account.teamId === null) {
    throw new ForbiddenError("Bu islem bir takim hesabiyla yapilir");
  }
  return account.teamId;
}

/**
 * Proves that every referenced account belongs to the tenant making the write.
 *
 * There is deliberately no active/archive filter here: historical work may
 * continue to name an archived account. The boundary this helper owns is team
 * membership, and a miss is always the same 404 whether the id is absent or
 * belongs to somebody else.
 */
export async function assertAccountsBelongToTeam(
  prisma: PrismaClient,
  teamId: string,
  accountIds: readonly string[]
): Promise<void> {
  const uniqueIds = [...new Set(accountIds)];
  if (uniqueIds.length === 0) return;

  const found = await prisma.account.count({
    where: { id: { in: uniqueIds }, teamId },
  });
  if (found !== uniqueIds.length) throw new NotFoundError("Hesap bulunamadi");
}
