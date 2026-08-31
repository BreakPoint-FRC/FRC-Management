import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { ConflictError } from "../../lib/http-errors";
import { createSetupService } from "./setup.service";

const TEAM = "team-1";

// The wizard owns the order of the steps and nothing else. What it has to get
// right is refusing to move on from a step whose prerequisites are not met --
// every later step writes rows that depend on them.
describe("advancing the wizard", () => {
  function stubPrisma(options: {
    stage?: string;
    name?: string;
    groups?: number;
    seasons?: number;
  }) {
    const update = vi.fn().mockResolvedValue({});
    return {
      prisma: {
        team: {
          findUnique: async () => ({
            id: TEAM,
            name: options.name ?? "Varsayilan Takim",
            slug: "t",
            isActive: true,
            setupStage: options.stage ?? "GROUPS",
            setupCompletedAt: null,
          }),
          update,
        },
        group: { count: async () => options.groups ?? 0 },
        role: { count: async () => 0 },
        groupTool: { count: async () => 0 },
        rolePermission: { count: async () => 0 },
        account: { count: async () => 1 },
        season: { count: async () => options.seasons ?? 0 },
      } as unknown as PrismaClient,
      update,
    };
  }

  it("refuses to leave GROUPS with no group", async () => {
    // Nothing after this step works without one: a role cannot be scoped to a
    // group that does not exist, and a tool cannot be assigned to one either.
    const { prisma } = stubPrisma({ stage: "GROUPS", groups: 0 });

    await expect(createSetupService(prisma).advance(TEAM)).rejects.toBeInstanceOf(ConflictError);
  });

  it("moves on once a group exists", async () => {
    const { prisma, update } = stubPrisma({ stage: "GROUPS", groups: 1 });

    await createSetupService(prisma).advance(TEAM);

    expect(update.mock.calls[0]?.[0].data).toMatchObject({ setupStage: "ROLES" });
  });

  it("does not insist a team invent roles it does not want", async () => {
    // Only the dependencies are enforced. A team that wants two roles and no
    // more is not wrong, so ROLES has no minimum.
    const { prisma, update } = stubPrisma({ stage: "ROLES", groups: 1 });

    await createSetupService(prisma).advance(TEAM);

    expect(update.mock.calls[0]?.[0].data).toMatchObject({ setupStage: "TOOLS" });
  });

  it("refuses to leave NAMING without a season", async () => {
    // Every operational record hangs off a season. Without one the team would
    // finish the wizard and land on a dashboard where nothing can be created,
    // and the error would read as a bug rather than a missing step.
    const { prisma } = stubPrisma({ stage: "NAMING", groups: 1, seasons: 0, name: "Cekirdek" });

    await expect(createSetupService(prisma).advance(TEAM)).rejects.toThrow(/sezon/i);
  });

  it("stamps setupCompletedAt only on reaching DONE", async () => {
    const { prisma, update } = stubPrisma({ stage: "ACCOUNTS", groups: 1, seasons: 1 });

    await createSetupService(prisma).advance(TEAM);

    expect(update.mock.calls[0]?.[0].data).toMatchObject({ setupStage: "DONE" });
    expect(update.mock.calls[0]?.[0].data.setupCompletedAt).toBeInstanceOf(Date);
  });

  it("refuses to advance past the end", async () => {
    const { prisma } = stubPrisma({ stage: "DONE", groups: 1, seasons: 1 });

    await expect(createSetupService(prisma).advance(TEAM)).rejects.toThrow(/zaten tamamlandi/);
  });
});

describe("going back", () => {
  function stubPrisma(stage: string) {
    const update = vi.fn().mockResolvedValue({});
    return {
      prisma: {
        team: {
          findUnique: async () => ({
            id: TEAM,
            name: "Cekirdek",
            slug: "cekirdek",
            isActive: true,
            setupStage: stage,
            setupCompletedAt: null,
          }),
          update,
        },
      } as unknown as PrismaClient,
      update,
    };
  }

  it("returns to a finished step", async () => {
    const { prisma, update } = stubPrisma("PERMISSIONS");

    await createSetupService(prisma).goBack(TEAM, "GROUPS");

    expect(update.mock.calls[0]?.[0].data).toMatchObject({ setupStage: "GROUPS" });
  });

  it("refuses to skip forward", async () => {
    // Forward is `advance`, which checks prerequisites. Allowing a named
    // destination here would be a way around them.
    const { prisma } = stubPrisma("GROUPS");

    await expect(createSetupService(prisma).goBack(TEAM, "ACCOUNTS")).rejects.toBeInstanceOf(
      ConflictError
    );
  });

  it("refuses to name the step already current", async () => {
    const { prisma } = stubPrisma("TOOLS");

    await expect(createSetupService(prisma).goBack(TEAM, "TOOLS")).rejects.toBeInstanceOf(
      ConflictError
    );
  });
});
