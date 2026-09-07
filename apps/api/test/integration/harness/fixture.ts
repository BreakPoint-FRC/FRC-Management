import { hash } from "@node-rs/argon2";
import type { PrismaClient } from "@breakpoint/db";
import { TOOL_KEYS, type ToolKey } from "@breakpoint/types";

/**
 * The password every fixture account is created with.
 *
 * Long enough for passwordSchema (ten characters), so the same value can be
 * sent to POST /auth/login and to the endpoints that create accounts.
 */
export const FIXTURE_PASSWORD = "Breakpoint-Test-2026!";

// argon2 is deliberately slow, and the fixture is rebuilt before every test.
// Hashing the one shared password once per process turns roughly a second of
// work per test into nothing; the hash itself is real, so /auth/login still
// verifies it the way it would in production.
let cachedHash: Promise<string> | null = null;
function fixturePasswordHash(): Promise<string> {
  cachedHash ??= hash(FIXTURE_PASSWORD);
  return cachedHash;
}

export interface TeamFixture {
  id: string;
  name: string;
  /** TEAM_WIDE, every tool but TEAMS, all four flags. */
  adminRoleId: string;
  adminAccountId: string;
  adminEmail: string;
  /** IN_GROUP in `groupId`: TASKS read/create/update and MEETINGS read. */
  memberRoleId: string;
  memberAccountId: string;
  memberEmail: string;
  /** Root department. Every tool is switched on here, so the child inherits. */
  groupId: string;
  /** A department under `groupId`, for the inheritance and tree cases. */
  childGroupId: string;
  seasonId: string;
  seasonName: string;
}

export interface Baseline {
  toolIds: Record<ToolKey, string>;
  /** Belongs to no team. The only account /teams will answer. */
  platform: { accountId: string; email: string; roleId: string };
  /** The team under test. */
  alpha: TeamFixture;
  /** A second team, so a cross-tenant id in a test is a real row, not a guess. */
  beta: TeamFixture;
}

const ALL = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };

/**
 * Writes the rows every integration test starts from, straight through Prisma.
 *
 * It goes around the API on purpose. What the suite is testing is the HTTP
 * surface, and building the world through that surface would mean a failure in
 * one endpoint failing every test for reasons that have nothing to do with it.
 *
 * The shape mirrors what the migrations and the setup wizard produce -- tools,
 * a team, its admin role with the full matrix, departments with their tools
 * switched on, an active season -- because that is the state a running
 * deployment is in. It is not the seed: the seed is sample data for a human
 * looking at the app, and this is the smallest world the rules can be checked
 * against.
 */
export async function seedBaseline(prisma: PrismaClient): Promise<Baseline> {
  await prisma.tool.createMany({
    data: TOOL_KEYS.map((key) => ({ key, name: key })),
  });
  const tools = await prisma.tool.findMany({ select: { id: true, key: true } });
  const toolIds = Object.fromEntries(tools.map((tool) => [tool.key, tool.id])) as Record<
    ToolKey,
    string
  >;

  const platform = await seedPlatformAdmin(prisma, toolIds);
  const alpha = await seedTeam(prisma, toolIds, "alpha", "Takim Alfa");
  const beta = await seedTeam(prisma, toolIds, "beta", "Takim Beta");

  return { toolIds, platform, alpha, beta };
}

/**
 * The account that opens teams: no teamId, and a role that belongs to no team.
 *
 * This is the identity requirePlatform() is written against, and having a real
 * one is what lets the suite show that a team account holding the same TEAMS
 * grant is still refused.
 */
async function seedPlatformAdmin(prisma: PrismaClient, toolIds: Record<ToolKey, string>) {
  const role = await prisma.role.create({
    data: {
      teamId: null,
      key: "SYSTEM_ADMIN",
      name: "Sistem Yoneticisi",
      placement: "TEAM_WIDE",
      isSystemRole: true,
    },
    select: { id: true },
  });

  await prisma.rolePermission.createMany({
    data: TOOL_KEYS.map((key) => ({ roleId: role.id, toolId: toolIds[key], ...ALL })),
  });

  const email = "platform@breakpoint.test";
  const account = await prisma.account.create({
    data: {
      teamId: null,
      email,
      fullName: "Platform Yoneticisi",
      passwordHash: await fixturePasswordHash(),
    },
    select: { id: true },
  });

  await prisma.accountRole.create({ data: { accountId: account.id, roleId: role.id } });

  return { accountId: account.id, email, roleId: role.id };
}

async function seedTeam(
  prisma: PrismaClient,
  toolIds: Record<ToolKey, string>,
  slug: string,
  name: string
): Promise<TeamFixture> {
  const passwordHash = await fixturePasswordHash();

  const team = await prisma.team.create({
    data: { name, slug, setupStage: "DONE", setupCompletedAt: new Date() },
    select: { id: true },
  });

  const group = await prisma.group.create({
    data: { teamId: team.id, name: "Yazilim" },
    select: { id: true },
  });
  const childGroup = await prisma.group.create({
    data: { teamId: team.id, name: "Tasarim", parentId: group.id },
    select: { id: true },
  });

  // On the root only. Tools inherit down the tree, so the child department is
  // covered without a row of its own -- and a test that turns one off on the
  // child has something to override.
  await prisma.groupTool.createMany({
    data: TOOL_KEYS.map((key) => ({ groupId: group.id, toolId: toolIds[key], isEnabled: true })),
  });

  const adminRole = await prisma.role.create({
    data: {
      teamId: team.id,
      key: "TEAM_ADMIN",
      name: "Takim Yoneticisi",
      placement: "TEAM_WIDE",
      isSystemRole: true,
    },
    select: { id: true },
  });

  // Every tool except TEAMS, exactly as teams.service writes it when it opens a
  // team. Running a team does not include opening new ones.
  await prisma.rolePermission.createMany({
    data: TOOL_KEYS.filter((key) => key !== "TEAMS").map((key) => ({
      roleId: adminRole.id,
      toolId: toolIds[key],
      ...ALL,
    })),
  });

  const memberRole = await prisma.role.create({
    data: {
      teamId: team.id,
      key: "MEMBER",
      name: "Uye",
      placement: "IN_GROUP",
    },
    select: { id: true },
  });

  // Deliberately narrow, and deliberately without `canDelete`: the 403 cases
  // want a real account whose permissions genuinely stop somewhere.
  await prisma.rolePermission.createMany({
    data: [
      {
        roleId: memberRole.id,
        toolId: toolIds.TASKS,
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canDelete: false,
      },
      {
        roleId: memberRole.id,
        toolId: toolIds.MEETINGS,
        canRead: true,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
      },
    ],
  });

  const adminEmail = `admin@${slug}.test`;
  const admin = await prisma.account.create({
    data: { teamId: team.id, email: adminEmail, fullName: "Ada Yilmaz", passwordHash },
    select: { id: true },
  });
  await prisma.accountRole.create({ data: { accountId: admin.id, roleId: adminRole.id } });

  const memberEmail = `member@${slug}.test`;
  const member = await prisma.account.create({
    data: { teamId: team.id, email: memberEmail, fullName: "Emre Demir", passwordHash },
    select: { id: true },
  });
  // An IN_GROUP role only counts for an active member of that group -- see
  // authorize(). Without the membership row this account would be refused from
  // its own department, which looks like a permission bug and is not.
  await prisma.accountRole.create({
    data: { accountId: member.id, roleId: memberRole.id, groupId: group.id },
  });
  await prisma.groupMembership.create({ data: { accountId: member.id, groupId: group.id } });

  const seasonName = "2026 Sezonu";
  const season = await prisma.season.create({
    data: {
      teamId: team.id,
      name: seasonName,
      startDate: new Date("2026-01-05T00:00:00.000Z"),
      endDate: new Date("2026-12-31T00:00:00.000Z"),
      isActive: true,
    },
    select: { id: true },
  });

  return {
    id: team.id,
    name,
    adminRoleId: adminRole.id,
    adminAccountId: admin.id,
    adminEmail,
    memberRoleId: memberRole.id,
    memberAccountId: member.id,
    memberEmail,
    groupId: group.id,
    childGroupId: childGroup.id,
    seasonId: season.id,
    seasonName,
  };
}
