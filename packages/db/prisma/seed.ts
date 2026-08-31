// Run via `pnpm --filter @breakpoint/db db:seed`, which loads the root .env
// with dotenv-cli first. Importing the client before DATABASE_URL is set would
// build the Postgres adapter with an undefined connection string.
import { hash } from "@node-rs/argon2";

import { prisma } from "../src/client";

// The seed fills a database with a realistic team. It does *not* create the
// team, roles, tools, the permission matrix or the departments -- those are
// system configuration written by migrations, because without them nobody can
// be authorized for anything and a deployed database would be inert. This file
// looks them up and fails loudly if they are missing.
//
// Everything it writes belongs to the one team the migrations create. It does
// not create the platform system admin either: that account is a way into every
// team, so it comes from `db:bootstrap` and its environment variables rather
// than from a file with a password printed in it.
//
// Everything here is upserted on a natural key (email, name, or a fixed seed-*
// id) so running it twice updates the same rows instead of piling up
// duplicates.

// Every seeded account shares this password. It exists so the login screen is
// usable the first time someone opens the app; it is documented in the README
// for exactly that reason and is worthless outside a local database.
const DEV_PASSWORD = "Breakpoint2026!";

const SEASON = {
  name: "2026 Season",
  startDate: new Date("2026-01-03T00:00:00.000Z"),
  endDate: new Date("2026-12-31T23:59:59.000Z"),
};

// A role is a position plus, for the two GROUP-scoped ones, the department it
// applies to -- "mekanik lead" is LEAD in Mechanical. Several people here hold
// more than one, which is the case the whole model exists for.
//
// `group` is required for a GROUP-scoped role and must be absent for a GLOBAL
// one. That is the rule accounts.service enforces on every write; the seed has
// to satisfy it too or it is not describing a state the API could produce.
const ACCOUNTS = [
  {
    // The administrator of this team, not of the platform. SYSTEM_ADMIN belongs
    // to no team and is created by db:bootstrap.
    email: "ada@breakpoint.test",
    fullName: "Ada Yilmaz",
    roles: [{ role: "TEAM_ADMIN" }],
    extraGroups: ["Programming"],
  },
  {
    email: "yagmur@breakpoint.test",
    fullName: "Yagmur Balikcayir",
    roles: [{ role: "MENTOR" }],
    extraGroups: [],
  },
  {
    // Mekanik lead ve baskan yardimcisi.
    email: "deniz@breakpoint.test",
    fullName: "Deniz Kaya",
    roles: [{ role: "LEAD", group: "Mechanical" }, { role: "VICE_PRESIDENT" }],
    extraGroups: [],
  },
  {
    email: "emre@breakpoint.test",
    fullName: "Emre Demir",
    roles: [{ role: "MEMBER", group: "Programming" }],
    extraGroups: [],
  },
  {
    // Baskan, ayni zamanda business ekibinde.
    email: "selin@breakpoint.test",
    fullName: "Selin Aydin",
    roles: [{ role: "PRESIDENT" }, { role: "MEMBER", group: "Business" }],
    extraGroups: [],
  },
  {
    // Iki departmanin lead'i.
    email: "kerem@breakpoint.test",
    fullName: "Kerem Ozturk",
    roles: [
      { role: "LEAD", group: "Programming" },
      { role: "LEAD", group: "Electrical" },
    ],
    extraGroups: [],
  },
  {
    email: "melis@breakpoint.test",
    fullName: "Melis Arslan",
    roles: [{ role: "LEAD", group: "Business" }],
    extraGroups: [],
  },
  {
    email: "baris@breakpoint.test",
    fullName: "Baris Sahin",
    roles: [{ role: "MEMBER", group: "Media" }, { role: "SOCIAL_DIRECTOR" }],
    extraGroups: [],
  },
  {
    // Nobody has decided where this one belongs yet -- the GLOBAL floor role.
    email: "yeni@breakpoint.test",
    fullName: "Yeni Uye",
    roles: [{ role: "TEAM_MEMBER" }],
    extraGroups: [],
  },
] as const;

async function main() {
  // The team the migrations created and adopted the existing data into. Looked
  // up rather than created, for the same reason the roles below are.
  const team = await prisma.team.findFirst({
    where: { slug: "varsayilan-takim" },
    select: { id: true, name: true },
  });
  if (!team) {
    throw new Error(
      'Team "varsayilan-takim" is missing. Run pnpm --filter @breakpoint/db db:deploy first.'
    );
  }
  const teamId = team.id;

  const season = await prisma.season.upsert({
    where: { teamId_name: { teamId, name: SEASON.name } },
    update: { startDate: SEASON.startDate, endDate: SEASON.endDate, isActive: true },
    create: { ...SEASON, teamId, isActive: true },
  });

  // Configuration written by the migration. Looked up rather than created, and
  // checked so a missing migration is an error here instead of a confusing
  // foreign key failure twenty lines down.
  const roles = new Map(
    (await prisma.role.findMany({ where: { teamId } })).map((role) => [role.key, role.id])
  );
  const groups = new Map(
    (await prisma.group.findMany({ where: { teamId } })).map((group) => [group.name, group.id])
  );

  const roleId = (key: string) => {
    const id = roles.get(key);
    if (!id) throw new Error(`Role "${key}" is missing. Run pnpm --filter @breakpoint/db db:deploy first.`);
    return id;
  };
  const groupId = (name: string) => {
    const id = groups.get(name);
    if (!id) throw new Error(`Group "${name}" is missing. Run pnpm --filter @breakpoint/db db:deploy first.`);
    return id;
  };

  const accountIds = new Map<string, string>();

  for (const spec of ACCOUNTS) {
    // Hashed per account rather than once and shared, so no two rows carry the
    // same salt even in a throwaway database.
    const passwordHash = await hash(DEV_PASSWORD);

    const account = await prisma.account.upsert({
      where: { email: spec.email },
      update: { teamId, fullName: spec.fullName, passwordHash, isActive: true, archivedAt: null },
      create: { teamId, email: spec.email, fullName: spec.fullName, passwordHash },
    });
    accountIds.set(spec.email, account.id);

    // Roles are replaced as a whole set, the same way the API writes them --
    // see docs/roles.md. Adding to the set instead would let a re-run stack
    // duplicates onto someone who already has them.
    await prisma.accountRole.deleteMany({ where: { accountId: account.id } });
    await prisma.accountRole.createMany({
      data: spec.roles.map((entry) => ({
        accountId: account.id,
        roleId: roleId(entry.role),
        groupId: "group" in entry ? groupId(entry.group) : null,
      })),
    });

    // Holding an IN_GROUP role implies membership of that group: without it
    // authorize() would turn a member away from their own department.
    const memberOf = new Set<string>(spec.extraGroups);
    for (const entry of spec.roles) if ("group" in entry) memberOf.add(entry.group);

    for (const name of memberOf) {
      await prisma.groupMembership.upsert({
        where: { accountId_groupId: { accountId: account.id, groupId: groupId(name) } },
        update: { isActive: true },
        create: { accountId: account.id, groupId: groupId(name), isActive: true },
      });
    }
  }

  const adminId = accountIds.get("ada@breakpoint.test")!;
  const mentorId = accountIds.get("yagmur@breakpoint.test")!;
  const denizId = accountIds.get("deniz@breakpoint.test")!;
  const emreId = accountIds.get("emre@breakpoint.test")!;
  const keremId = accountIds.get("kerem@breakpoint.test")!;
  const melisId = accountIds.get("melis@breakpoint.test")!;

  // A team-wide meeting (no group) and a department one, so both authorization
  // paths -- GLOBAL and group-scoped -- have data behind them.
  const meetings = [
    {
      id: "seed-meeting-kickoff",
      title: "Season kickoff",
      body: "# Kickoff\n\nWent over the V1 scope and split the build between groups.",
      meetingDate: new Date("2026-09-01T17:00:00.000Z"),
      groupId: null,
      createdById: adminId,
    },
    {
      id: "seed-meeting-software-sync",
      title: "Yazilim haftalik",
      body: "Autonomous rutini ve vision pipeline durumu.",
      meetingDate: new Date("2026-09-08T17:00:00.000Z"),
      groupId: groupId("Programming"),
      createdById: keremId,
    },
  ];

  for (const meeting of meetings) {
    await prisma.meeting.upsert({
      where: { id: meeting.id },
      update: { title: meeting.title, body: meeting.body, meetingDate: meeting.meetingDate },
      create: { ...meeting, teamId, seasonId: season.id },
    });
  }

  // Roll call. A boolean could not say "late" or "excused", which is most of
  // what roll call actually records.
  const attendance = [
    { accountId: adminId, status: "PRESENT" as const },
    { accountId: mentorId, status: "PRESENT" as const },
    { accountId: denizId, status: "LATE" as const, note: "Servis gecikti." },
    { accountId: emreId, status: "ABSENT" as const },
    { accountId: keremId, status: "PRESENT" as const },
    { accountId: melisId, status: "EXCUSED" as const, note: "Sinav." },
  ];

  for (const entry of attendance) {
    await prisma.meetingAttendance.upsert({
      where: {
        meetingId_accountId: { meetingId: "seed-meeting-kickoff", accountId: entry.accountId },
      },
      update: { status: entry.status, note: entry.note ?? null },
      create: {
        meetingId: "seed-meeting-kickoff",
        accountId: entry.accountId,
        status: entry.status,
        note: entry.note ?? null,
      },
    });
  }

  // startDate and dueDate are what the Gantt board below draws; it stores no
  // dates of its own.
  const tasks = [
    {
      id: "seed-task-intake",
      name: "Design the intake rollers",
      description: "Two-stage intake, has to clear the bumper.",
      status: "IN_PROGRESS" as const,
      priority: "HIGH" as const,
      groupId: groupId("Mechanical"),
      startDate: new Date("2026-09-02T00:00:00.000Z"),
      dueDate: new Date("2026-09-20T00:00:00.000Z"),
      createdById: denizId,
      assignees: [denizId],
    },
    {
      id: "seed-task-auto",
      name: "Write the autonomous routine",
      description: null,
      status: "TODO" as const,
      priority: "CRITICAL" as const,
      groupId: groupId("Programming"),
      startDate: new Date("2026-09-05T00:00:00.000Z"),
      dueDate: new Date("2026-10-01T00:00:00.000Z"),
      createdById: keremId,
      // Two people on one task: the case a single assigneeId column could not
      // describe.
      assignees: [emreId, keremId],
    },
    {
      id: "seed-task-sponsor-deck",
      name: "Update the sponsorship deck",
      description: "Cross-group: needs numbers from finance.",
      status: "COMPLETED" as const,
      priority: "MEDIUM" as const,
      // No group. A cross-group task is authorized on the team-wide path.
      groupId: null,
      startDate: new Date("2026-08-10T00:00:00.000Z"),
      dueDate: new Date("2026-08-25T00:00:00.000Z"),
      createdById: melisId,
      assignees: [melisId, adminId],
    },
    {
      id: "seed-task-wiring",
      name: "Robot kablolama plani",
      description: "Elektronik ve mekanik birlikte.",
      status: "BLOCKED" as const,
      priority: "HIGH" as const,
      groupId: groupId("Electrical"),
      startDate: new Date("2026-09-10T00:00:00.000Z"),
      dueDate: new Date("2026-09-30T00:00:00.000Z"),
      createdById: keremId,
      assignees: [keremId],
    },
  ];

  for (const { assignees, ...task } of tasks) {
    await prisma.task.upsert({
      where: { id: task.id },
      update: {
        name: task.name,
        description: task.description,
        status: task.status,
        priority: task.priority,
        startDate: task.startDate,
        dueDate: task.dueDate,
      },
      create: { ...task, teamId, seasonId: season.id },
    });

    // Assignees are a set, replaced whole, exactly like roles.
    await prisma.taskAssignee.deleteMany({ where: { taskId: task.id } });
    await prisma.taskAssignee.createMany({
      data: assignees.map((accountId) => ({ taskId: task.id, accountId })),
    });
  }

  // One log line per seeded task, so the activity endpoint has something real
  // to return. The API writes these inside the same transaction as the change
  // they describe; here there is only the creation to record.
  for (const task of tasks) {
    const existing = await prisma.taskActivity.findFirst({
      where: { taskId: task.id, action: "CREATED" },
    });
    if (!existing) {
      await prisma.taskActivity.create({
        data: {
          taskId: task.id,
          actorId: task.createdById,
          action: "CREATED",
          newValue: { name: task.name, status: task.status, priority: task.priority },
        },
      });
    }
  }

  // Ordering only -- no dates, no status. Those are read from Task through the
  // join, so the board cannot drift from the work it draws.
  const board = await prisma.ganttBoard.upsert({
    where: {
      seasonId_groupId_name: {
        seasonId: season.id,
        groupId: groupId("Programming"),
        name: "Yazilim yol haritasi",
      },
    },
    update: {},
    create: {
      teamId,
      seasonId: season.id,
      groupId: groupId("Programming"),
      name: "Yazilim yol haritasi",
    },
  });

  for (const [index, taskId] of ["seed-task-auto", "seed-task-wiring"].entries()) {
    await prisma.ganttTask.upsert({
      where: { ganttBoardId_taskId: { ganttBoardId: board.id, taskId } },
      update: { displayOrder: index },
      create: { ganttBoardId: board.id, taskId, displayOrder: index },
    });
  }

  // Money is a Decimal column and crosses the API as a string; passing these as
  // strings here keeps it out of a JavaScript float on the way in too.
  const transactions = [
    {
      id: "seed-transaction-sponsor",
      type: "INCOME" as const,
      category: "Sponsorluk",
      amount: "25000.00",
      description: "Anadolu Robotics - sezon sponsorlugu, ilk taksit.",
      transactionDate: new Date("2026-08-20T00:00:00.000Z"),
      groupId: groupId("Business"),
      createdById: adminId,
    },
    {
      id: "seed-transaction-parts",
      type: "EXPENSE" as const,
      category: "Parca",
      amount: "4750.50",
      description: "Drivetrain parcalari.",
      transactionDate: new Date("2026-08-24T00:00:00.000Z"),
      groupId: groupId("Mechanical"),
      createdById: mentorId,
    },
    {
      id: "seed-transaction-travel",
      type: "EXPENSE" as const,
      category: "Ulasim",
      amount: "1200.00",
      description: "Bolgesel turnuva ulasim avansi.",
      transactionDate: new Date("2026-09-02T00:00:00.000Z"),
      groupId: null,
      createdById: adminId,
    },
  ];

  for (const transaction of transactions) {
    await prisma.financeTransaction.upsert({
      where: { id: transaction.id },
      update: {
        category: transaction.category,
        amount: transaction.amount,
        description: transaction.description,
      },
      create: { ...transaction, teamId, seasonId: season.id },
    });
  }

  // A company is separate from its relationship with the team, so the same firm
  // can be a candidate one season and a sponsor the next without rewriting
  // history.
  const organizations = [
    {
      name: "Anadolu Robotics",
      website: "https://anadolurobotics.example",
      email: "destek@anadolurobotics.example",
      phone: "+90 212 000 0000",
      status: "SPONSOR" as const,
      amount: "25000.00",
      assignedToId: melisId,
    },
    {
      name: "Marmara Makina",
      website: "https://marmaramakina.example",
      email: null,
      phone: null,
      status: "NEGOTIATING" as const,
      amount: null,
      assignedToId: melisId,
    },
    {
      name: "Ege Yazilim",
      website: null,
      email: "info@egeyazilim.example",
      phone: null,
      status: "CANDIDATE" as const,
      amount: null,
      assignedToId: null,
    },
  ];

  for (const { status, amount, assignedToId, ...organization } of organizations) {
    const record = await prisma.organization.upsert({
      where: { teamId_name: { teamId, name: organization.name } },
      update: organization,
      create: { ...organization, teamId },
    });

    await prisma.sponsorship.upsert({
      where: {
        organizationId_seasonId: { organizationId: record.id, seasonId: season.id },
      },
      update: { status, amount, assignedToId },
      create: {
        teamId,
        organizationId: record.id,
        seasonId: season.id,
        status,
        amount,
        assignedToId,
      },
    });
  }

  console.log(
    [
      `Seeded team "${team.name}" with ${ACCOUNTS.length} accounts (password: ${DEV_PASSWORD})`,
      `${roles.size} roles, ${groups.size} groups`,
      `${meetings.length} meetings, ${tasks.length} tasks`,
      `${transactions.length} transactions, ${organizations.length} sponsorships`,
      `season "${season.name}".`,
    ].join(", ")
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
