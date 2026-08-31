import { createHash, randomBytes } from "node:crypto";

import type { PrismaClient } from "@breakpoint/db";
import { roleDepths } from "@breakpoint/types";

import { UnauthorizedError } from "../../lib/http-errors";
import { hashPassword, verifyPassword } from "../../lib/password";
import { resolvePermissionMatrix } from "../../lib/authorize";
import type { ChangePasswordInput } from "./auth.schema";

const REFRESH_TOKEN_BYTES = 48;

function refreshTokenTtlMs(): number {
  const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);
  return (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000;
}

/**
 * Refresh tokens are hashed with SHA-256, not argon2.
 *
 * Argon2 is slow on purpose because a password is low-entropy and guessable.
 * A refresh token is 48 random bytes -- there is nothing to guess, so the only
 * job left is making a stolen database dump useless, which a plain digest does
 * just as well. Using argon2 here would put ~50ms on every token refresh to
 * defend against an attack that does not exist.
 */
function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createAuthService(prisma: PrismaClient) {
  const issueRefreshToken = async (accountId: string, userAgent?: string) => {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");

    await prisma.refreshToken.create({
      data: {
        accountId,
        tokenHash: digest(token),
        userAgent: userAgent?.slice(0, 255) ?? null,
        expiresAt: new Date(Date.now() + refreshTokenTtlMs()),
      },
    });

    return token;
  };

  return {
    issueRefreshToken,

    /**
     * Verifies credentials. The same error is returned for an unknown email, a
     * wrong password and a deactivated account, so the endpoint cannot be used
     * to find out which addresses have accounts.
     */
    login: async (email: string, password: string) => {
      const account = await prisma.account.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          fullName: true,
          passwordHash: true,
          isActive: true,
          archivedAt: true,
          team: { select: { isActive: true } },
        },
      });

      // Hash a throwaway value when there is no account, so a request for an
      // unknown address takes as long as one for a known address. Without it
      // the response time answers the question the error message refuses to.
      const passwordMatches = account
        ? await verifyPassword(account.passwordHash, password)
        : await verifyPassword("!no-password-set", password);

      if (
        !account ||
        !passwordMatches ||
        !account.isActive ||
        account.archivedAt ||
        (account.team !== null && !account.team.isActive)
      ) {
        throw new UnauthorizedError("E-posta veya sifre hatali");
      }

      return { id: account.id, email: account.email, fullName: account.fullName };
    },

    /**
     * Exchanges a refresh token for the next one, invalidating the old.
     *
     * A token that is presented twice is the signal that matters: either it was
     * stolen and the thief got there first, or it was stolen after the owner
     * used it. There is no way to tell which, so every session for that account
     * is revoked and everyone has to sign in again.
     */
    rotateRefreshToken: async (token: string, userAgent?: string) => {
      const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: digest(token) },
        select: { id: true, accountId: true, expiresAt: true, revokedAt: true },
      });

      if (!stored) throw new UnauthorizedError("Oturum suresi doldu");

      if (stored.revokedAt) {
        await prisma.refreshToken.updateMany({
          where: { accountId: stored.accountId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        throw new UnauthorizedError("Oturum guvenlik nedeniyle sonlandirildi");
      }

      if (stored.expiresAt <= new Date()) {
        throw new UnauthorizedError("Oturum suresi doldu");
      }

      const account = await prisma.account.findUnique({
        where: { id: stored.accountId },
        select: {
          id: true,
          email: true,
          fullName: true,
          isActive: true,
          archivedAt: true,
          team: { select: { isActive: true } },
        },
      });

      if (
        !account ||
        !account.isActive ||
        account.archivedAt ||
        (account.team !== null && !account.team.isActive)
      ) {
        throw new UnauthorizedError("Hesap aktif degil");
      }

      // Revoking the old row and writing the new one in one transaction: a
      // crash between them would either hand out a token nothing can revoke or
      // leave the account with no way back in.
      const next = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
      await prisma.$transaction([
        prisma.refreshToken.update({
          where: { id: stored.id },
          data: { revokedAt: new Date() },
        }),
        prisma.refreshToken.create({
          data: {
            accountId: account.id,
            tokenHash: digest(next),
            userAgent: userAgent?.slice(0, 255) ?? null,
            expiresAt: new Date(Date.now() + refreshTokenTtlMs()),
          },
        }),
      ]);

      return {
        token: next,
        account: { id: account.id, email: account.email, fullName: account.fullName },
      };
    },

    /** Idempotent: logging out twice, or with a token that never existed, is fine. */
    revokeRefreshToken: async (token: string) => {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: digest(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    },

    changePassword: async (accountId: string, input: ChangePasswordInput) => {
      const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: { passwordHash: true },
      });

      if (!account || !(await verifyPassword(account.passwordHash, input.currentPassword))) {
        throw new UnauthorizedError("Mevcut sifre hatali");
      }

      // Every other session is revoked: changing a password is what someone
      // does when they think it leaked, and leaving the old sessions alive
      // would defeat the point.
      await prisma.$transaction([
        prisma.account.update({
          where: { id: accountId },
          data: {
            passwordHash: await hashPassword(input.newPassword),
            // Clearing this is the whole point of the flag: the account is now
            // on a password only its owner has typed.
            mustChangePassword: false,
          },
        }),
        prisma.refreshToken.updateMany({
          where: { accountId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
    },

    /**
     * Account, team, roles, departments and the permission map the UI renders
     * from.
     *
     * The team block carries setupStage, which is what sends a team admin into
     * the setup wizard instead of the dashboard on their first sign-in. It is
     * null for a platform system admin, who has no team and no wizard.
     */
    profile: async (accountId: string) => {
      const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          email: true,
          fullName: true,
          isActive: true,
          mustChangePassword: true,
          archivedAt: true,
          team: {
            select: {
              id: true,
              name: true,
              slug: true,
              isActive: true,
              setupStage: true,
              setupCompletedAt: true,
            },
          },
          roles: {
            where: { isActive: true },
            select: {
              groupId: true,
              role: { select: { id: true, key: true, name: true, placement: true } },
              group: { select: { name: true } },
            },
          },
          memberships: {
            where: { isActive: true },
            select: { group: { select: { id: true, name: true, description: true } } },
          },
        },
      });

      if (
        !account ||
        !account.isActive ||
        account.archivedAt !== null ||
        (account.team !== null && !account.team.isActive)
      ) {
        throw new UnauthorizedError("Hesap aktif degil");
      }

      // Depth comes from the RoleHierarchy edges, computed here rather than
      // stored. It is only for display order, which is why a cheap pass over
      // the roles this account holds is enough.
      const roleIds = account.roles.map((entry) => entry.role.id);
      const edges =
        roleIds.length === 0
          ? []
          : await prisma.roleHierarchy.findMany({
              where: { parentRoleId: { in: roleIds }, childRoleId: { in: roleIds } },
              select: { parentRoleId: true, childRoleId: true },
            });
      const depths = roleDepths(roleIds, edges);

      const permissions = await resolvePermissionMatrix(prisma, accountId);

      return {
        account: {
          id: account.id,
          email: account.email,
          fullName: account.fullName,
          isActive: account.isActive,
          mustChangePassword: account.mustChangePassword,
          teamId: account.team?.id ?? null,
          archivedAt: account.archivedAt,
        },
        team: account.team,
        roles: account.roles.map((entry) => ({
          roleId: entry.role.id,
          roleKey: entry.role.key,
          roleName: entry.role.name,
          placement: entry.role.placement,
          depth: depths.get(entry.role.id) ?? 0,
          groupId: entry.groupId,
          groupName: entry.group?.name ?? null,
        })),
        groups: account.memberships.map((entry) => entry.group),
        permissions,
      };
    },
  };
}
