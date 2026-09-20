import { hash } from "@node-rs/argon2";

import type { PrismaClient } from "./generated/prisma/client";

// Fixed id, written by 20260831090300. Matched on rather than on the key,
// because a team may also have a role keyed SYSTEM_ADMIN and only this one has
// no team.
export const PLATFORM_SYSTEM_ADMIN_ROLE_ID = "rl00000000000000systemadmin";

// Serializes the manual bootstrap operation across processes. The role's
// groupId is null, and Postgres considers null values distinct in a unique
// constraint, so the schema alone cannot prevent two concurrent A/B recovery
// commands from both deciding they are the sole administrator.
const PLATFORM_ADMIN_BOOTSTRAP_LOCK_ID = 671_324_519;

export interface BootstrapSystemAdminInput {
  email: string;
  password: string;
}

interface BootstrapDependencies {
  hashPassword: (password: string) => Promise<string>;
}

const defaultDependencies: BootstrapDependencies = { hashPassword: hash };

// Literal defaults from .env.example. Never valid to bootstrap with -- their
// only legitimate appearance is in a file nobody has edited yet.
const PLACEHOLDER_EMAIL = "admin@breakpoint.test";
const PLACEHOLDER_PASSWORD = "change-me-at-least-ten-chars";

/**
 * Creates or recovers the platform administrator.
 *
 * Recovery changes every security-relevant row in one transaction: the
 * password and temporary-password flag, all live refresh tokens, and the role
 * assignment. A failed rerun therefore leaves either the old administrator or
 * the completely recovered one, never a mixture of both.
 *
 * Two things this transaction refuses to do silently, both found in review
 * before this shipped:
 *
 * 1. Hijack an unrelated account. `email` is globally unique (see
 *    schema.prisma), not scoped to "platform admins" -- without this check,
 *    pointing SYSTEM_ADMIN_EMAIL at an existing team member's address would
 *    upsert straight into their account: rip it out of its team (`teamId:
 *    null`), overwrite its password, and hand it the platform role. Refused
 *    instead, with an error that says whose account it collided with.
 * 2. Leave a second platform admin behind. Bootstrapping with a *different*
 *    email than last time is a legitimate recovery (the old admin's inbox is
 *    gone), but upsert alone only ever grants -- it never looks at who else
 *    already holds the role. Every other active holder of
 *    PLATFORM_SYSTEM_ADMIN_ROLE_ID is deactivated and has its refresh tokens
 *    revoked in the same transaction. A transaction-scoped advisory lock also
 *    serializes simultaneous recovery commands, so bootstrapping leaves
 *    exactly one platform admin, matching what docs/deployment.md promises.
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
  if (input.email === PLACEHOLDER_EMAIL || input.password === PLACEHOLDER_PASSWORD) {
    throw new Error(
      "SYSTEM_ADMIN_EMAIL/SYSTEM_ADMIN_PASSWORD are still the .env.example placeholders. Set real values before running this."
    );
  }

  const passwordHash = await dependencies.hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    // $executeRaw intentionally ignores the SELECT result. $queryRaw tries to
    // deserialize PostgreSQL's `void` return type and Prisma rejects it before
    // the transaction can continue, even though the lock was acquired.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_ADMIN_BOOTSTRAP_LOCK_ID}::bigint)`;

    const role = await tx.role.findUnique({
      where: { id: PLATFORM_SYSTEM_ADMIN_ROLE_ID },
      select: { id: true },
    });
    if (!role) {
      throw new Error(
        "The platform SYSTEM_ADMIN role is missing. Run pnpm --filter @breakpoint/db db:deploy first."
      );
    }

    const existingByEmail = await tx.account.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        teamId: true,
        // An inactive assignment is deliberate history: it proves this
        // platform account held the role before and may be recovered after an
        // A -> B -> A handover. An unrelated platform account has no such row.
        roles: { where: { roleId: role.id, groupId: null }, select: { id: true } },
      },
    });
    const hasHeldThisPlatformAdminRole =
      existingByEmail !== null && existingByEmail.teamId === null && existingByEmail.roles.length > 0;

    if (existingByEmail && !hasHeldThisPlatformAdminRole) {
      throw new Error(
        `An account already exists with ${input.email}, and it is not the platform admin -- it belongs to ` +
          `${existingByEmail.teamId ? "a team" : "the platform but without the SYSTEM_ADMIN role"}. ` +
          "Refusing to convert it: use a different SYSTEM_ADMIN_EMAIL, or remove that account first if this really is intended."
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
        fullName: "Sistem Yöneticisi",
        passwordHash,
        teamId: null,
        mustChangePassword: false,
      },
      select: { id: true, email: true },
    });

    // A password reset is also an account recovery operation. Refresh tokens
    // issued under the old password must not survive it. Stateless access JWTs
    // can remain valid until JWT_ACCESS_TTL; docs/deployment.md calls that out.
    await tx.refreshToken.updateMany({
      where: { accountId: account.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // findFirst then create, not upsert: Postgres treats NULLs as distinct in a
    // unique index, so @@unique([accountId, roleId, groupId]) cannot identify
    // this assignment when groupId is null.
    const existingAssignment = await tx.accountRole.findFirst({
      where: { accountId: account.id, roleId: role.id, groupId: null },
      select: { id: true },
    });

    if (existingAssignment) {
      await tx.accountRole.update({ where: { id: existingAssignment.id }, data: { isActive: true } });
    } else {
      await tx.accountRole.create({ data: { accountId: account.id, roleId: role.id } });
    }

    // Exactly one platform admin after this returns: anyone else still
    // holding the role -- the previous admin, if this call just moved the
    // identity to a new email -- loses it, and its refresh tokens are revoked.
    const otherAdmins = await tx.accountRole.findMany({
      where: { roleId: role.id, groupId: null, isActive: true, accountId: { not: account.id } },
      select: { id: true, accountId: true },
    });

    if (otherAdmins.length > 0) {
      await tx.accountRole.updateMany({
        where: { id: { in: otherAdmins.map((a) => a.id) } },
        data: { isActive: false },
      });
      await tx.refreshToken.updateMany({
        where: { accountId: { in: otherAdmins.map((a) => a.accountId) }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return account;
  });
}
