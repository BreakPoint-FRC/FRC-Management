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
 * The mirror of requireTeam: proves the caller is *not* inside a team.
 *
 * Guards the platform surface -- every /teams operation and mutations of the
 * module catalogue under /tools. Catalogue reads stay permission-controlled
 * for team setup. There is no id to return, because that is the point: what is
 * being checked is that the account belongs to no team.
 *
 * It reads the account rather than a permission row, and that is deliberate.
 * `authorize()` decides on RolePermission rows, and its TEAM_WIDE bypass cannot
 * tell a platform role from a team-wide role a team wrote for itself -- both are
 * a placement, not a tenancy. So a team admin who granted their own new role
 * TEAMS passed every check and opened teams. This is the check that answer
 * cannot reach: an account with a teamId is refused here whatever any row says,
 * including one written straight to the database.
 *
 * Called *before* authorize on those routes: it is synchronous and cheap, and
 * the query behind authorize is neither.
 */
export function requirePlatform(account: AuthenticatedAccount): void {
  if (account.teamId !== null) {
    throw new ForbiddenError("Bu islem platform hesabiyla yapilir");
  }
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
