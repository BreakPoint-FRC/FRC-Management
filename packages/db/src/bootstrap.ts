import { hash } from "@node-rs/argon2";

import type { PrismaClient } from "./generated/prisma/client";

// Fixed id, written by 20260831090300. Matched on rather than on the key,
// because a team may also have a role keyed SYSTEM_ADMIN and only this one has
// no team.
export const PLATFORM_SYSTEM_ADMIN_ROLE_ID = "rl00000000000000systemadmin";

export interface BootstrapSystemAdminInput {
  email: string;
  password: string;
}

interface BootstrapDependencies {
  hashPassword: (password: string) => Promise<string>;
}

const defaultDependencies: BootstrapDependencies = { hashPassword: hash };

/**
 * Creates or recovers the platform administrator.
 *
 * Recovery changes every security-relevant row in one transaction: the
 * password and temporary-password flag, all live refresh tokens, and the role
 * assignment. A failed rerun therefore leaves either the old administrator or
 * the completely recovered one, never a mixture of both.
 */
export async function bootstrapSystemAdmin(
  prisma: PrismaClient,
  input: BootstrapSystemAdminInput,
  dependencies: BootstrapDependencies = defaultDependencies
): Promise<{ id: string; email: string }> {
  if (!input.email || !input.password) {
    throw new Error("SYSTEM_ADMIN_EMAIL and SYSTEM_ADMIN_PASSWORD must both be set. See .env.example.");
  }
  if (input.password.length < 10) {
    throw new Error("SYSTEM_ADMIN_PASSWORD must be at least 10 characters.");
  }

  const passwordHash = await dependencies.hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    const role = await tx.role.findUnique({
      where: { id: PLATFORM_SYSTEM_ADMIN_ROLE_ID },
      select: { id: true },
    });
    if (!role) {
      throw new Error(
        "The platform SYSTEM_ADMIN role is missing. Run pnpm --filter @breakpoint/db db:deploy first."
      );
    }

    const account = await tx.account.upsert({
      where: { email: input.email },
      // teamId stays null on purpose: a platform admin that sat inside a team
      // would be a back door into it.
      update: {
        passwordHash,
        teamId: null,
        isActive: true,
        archivedAt: null,
        mustChangePassword: false,
      },
      create: {
        email: input.email,
        fullName: "Sistem Yoneticisi",
        passwordHash,
        teamId: null,
        mustChangePassword: false,
      },
      select: { id: true, email: true },
    });

    // A password reset is also an account recovery operation. No token issued
    // under the old password may survive it.
    await tx.refreshToken.updateMany({
      where: { accountId: account.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // findFirst then create, not upsert: Postgres treats NULLs as distinct in a
    // unique index, so @@unique([accountId, roleId, groupId]) cannot identify
    // this assignment when groupId is null.
    const existing = await tx.accountRole.findFirst({
      where: { accountId: account.id, roleId: role.id, groupId: null },
      select: { id: true },
    });

    if (existing) {
      await tx.accountRole.update({ where: { id: existing.id }, data: { isActive: true } });
    } else {
      await tx.accountRole.create({ data: { accountId: account.id, roleId: role.id } });
    }

    return account;
  });
}
