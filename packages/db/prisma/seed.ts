// Run via `pnpm --filter @breakpoint/db db:seed`, which loads the root .env
// with dotenv-cli first. Importing the client before DATABASE_URL is set would
// build the Postgres adapter with an undefined connection string.
import { prisma } from "../src/client";

// Stable ids rather than cuid()s: re-running the seed updates the same rows
// instead of piling up duplicates, so it is safe to run against a database you
// have already been clicking around in.
const MEMBERS = [
  { id: "seed-member-admin", name: "Ada Yilmaz", email: "ada@breakpoint.test", role: "ADMIN" },
  { id: "seed-member-mentor", name: "Yagmur Balikcayir", email: "yagmur@breakpoint.test", role: "MENTOR" },
  { id: "seed-member-student-1", name: "Deniz Kaya", email: "deniz@breakpoint.test", role: "STUDENT" },
  { id: "seed-member-student-2", name: "Emre Demir", email: "emre@breakpoint.test", role: "STUDENT" },
] as const;

const GROUPS = [
  { id: "seed-group-mechanical", name: "Mechanical" },
  { id: "seed-group-software", name: "Software" },
] as const;

const MEETING_ID = "seed-meeting-kickoff";

async function main() {
  for (const member of MEMBERS) {
    await prisma.member.upsert({
      where: { id: member.id },
      update: { name: member.name, email: member.email, role: member.role },
      create: { ...member },
    });
  }

  for (const group of GROUPS) {
    await prisma.group.upsert({
      where: { id: group.id },
      update: { name: group.name },
      create: { ...group },
    });
  }

  const memberships = [
    { groupId: "seed-group-mechanical", memberId: "seed-member-student-1" },
    { groupId: "seed-group-software", memberId: "seed-member-student-2" },
    { groupId: "seed-group-software", memberId: "seed-member-admin" },
  ];

  for (const membership of memberships) {
    await prisma.groupMember.upsert({
      where: { groupId_memberId: membership },
      update: {},
      create: membership,
    });
  }

  await prisma.meeting.upsert({
    where: { id: MEETING_ID },
    update: {},
    create: {
      id: MEETING_ID,
      title: "Season kickoff",
      scheduledAt: new Date("2026-09-01T17:00:00.000Z"),
      report: "# Kickoff\n\nWent over the V1 scope and split the build between groups.",
    },
  });

  // Everyone but the second student showed up.
  for (const member of MEMBERS) {
    await prisma.attendance.upsert({
      where: { meetingId_memberId: { meetingId: MEETING_ID, memberId: member.id } },
      update: {},
      create: {
        meetingId: MEETING_ID,
        memberId: member.id,
        present: member.id !== "seed-member-student-2",
      },
    });
  }

  const tasks = [
    {
      id: "seed-task-intake",
      title: "Design the intake rollers",
      description: "Two-stage intake, has to clear the bumper.",
      status: "IN_PROGRESS",
      groupId: "seed-group-mechanical",
      assigneeId: "seed-member-student-1",
    },
    {
      id: "seed-task-auto",
      title: "Write the autonomous routine",
      description: null,
      status: "TODO",
      groupId: "seed-group-software",
      assigneeId: "seed-member-student-2",
    },
    {
      id: "seed-task-sponsor-deck",
      title: "Update the sponsorship deck",
      description: "Cross-group: needs numbers from finance.",
      status: "DONE",
      groupId: null,
      assigneeId: "seed-member-admin",
    },
  ] as const;

  for (const task of tasks) {
    await prisma.task.upsert({
      where: { id: task.id },
      update: {},
      create: { ...task },
    });
  }

  const transactions = [
    {
      id: "seed-transaction-sponsor",
      type: "INCOME",
      amount: "25000.00",
      counterparty: "Anadolu Robotics (sponsor)",
      note: "Season sponsorship, first instalment.",
      recordedById: "seed-member-admin",
    },
    {
      id: "seed-transaction-parts",
      type: "EXPENSE",
      amount: "4750.50",
      counterparty: "Vendor - drivetrain parts",
      note: null,
      recordedById: "seed-member-mentor",
    },
  ] as const;

  for (const transaction of transactions) {
    await prisma.transaction.upsert({
      where: { id: transaction.id },
      update: {},
      create: { ...transaction },
    });
  }

  console.log(
    `Seeded ${MEMBERS.length} members, ${GROUPS.length} groups, 1 meeting, ${tasks.length} tasks, ${transactions.length} transactions.`
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
