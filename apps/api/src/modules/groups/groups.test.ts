import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { ConflictError, NotFoundError } from "../../lib/http-errors";
import { createGroupsService } from "./groups.service";

// Teknik
//   +- Mekanik
//        +- Tasarim
// Medya
const TREE = [
  { id: "teknik", parentId: null },
  { id: "mekanik", parentId: "teknik" },
  { id: "tasarim", parentId: "mekanik" },
  { id: "medya", parentId: null },
];

const TEAM = "team-1";

// The group tree is a graph the database cannot police: Prisma can express
// neither a CHECK for the self-edge nor a recursive assertion for a cycle, and
// adding one by hand desynchronises schema.prisma permanently. So the write
// path is the only guard, and these are the tests of it.
describe("the group tree", () => {
  /** `records` is what the subtree has done: zero means it can be deleted. */
  function stubPrisma(
    groupOverrides: Record<string, unknown> = {},
    records: { tasks?: number; meetings?: number } = {}
  ) {
    return {
      group: {
        findMany: async () => TREE,
        count: async () => 1,
        update: vi.fn().mockResolvedValue({ id: "mekanik", tools: [], _count: { memberships: 0 } }),
        updateMany: vi.fn(),
        delete: vi.fn(),
        ...groupOverrides,
      },
      task: { count: async () => records.tasks ?? 0 },
      meeting: { count: async () => records.meetings ?? 0 },
      ganttBoard: { count: async () => 0 },
      financeTransaction: { count: async () => 0 },
      groupTool: { findMany: async () => [] },
      accountRole: { updateMany: vi.fn() },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;
  }

  it("refuses a group as its own parent", async () => {
    const service = createGroupsService(stubPrisma());

    await expect(
      service.update(TEAM, "mekanik", { parentId: "mekanik" })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a parent that is one of its own descendants", async () => {
    // Making Tasarim the parent of Teknik closes the loop Teknik > Mekanik >
    // Tasarim. authorize() expands subtrees on every scoped request, so a loop
    // is a hung request rather than a wrong answer.
    const service = createGroupsService(stubPrisma());

    await expect(service.update(TEAM, "teknik", { parentId: "tasarim" })).rejects.toThrow(
      /dongu/
    );
  });

  it("allows a move that only deepens the tree", async () => {
    const service = createGroupsService(stubPrisma());

    await expect(service.update(TEAM, "medya", { parentId: "teknik" })).resolves.toBeTruthy();
  });

  it("refuses a parent from another team", async () => {
    // Without this a team could nest its department under another team's, and
    // the subtree expansion in authorize() would honour it.
    const service = createGroupsService(stubPrisma({ count: async () => 0 }));

    await expect(
      service.update(TEAM, "mekanik", { parentId: "someone-elses-group" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("retires the whole subtree when it has work behind it", async () => {
    // A live Tasarim under a retired Mekanik is a department nobody can reach
    // through the tree and nobody meant to keep.
    const updateMany = vi.fn();
    const service = createGroupsService(stubPrisma({ updateMany }, { tasks: 2 }));

    const result = await service.remove(TEAM, "teknik");

    expect(result).toEqual({ removed: 0, retired: 3 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["teknik", "mekanik", "tasarim"] } },
      data: { isActive: false },
    });
  });

  it("deletes outright when nothing points at it", async () => {
    // A group created a minute ago by mistake is not history. Retiring it would
    // leave a tombstone the team can never clear, still holding its name
    // against the next department that wants it.
    const remove = vi.fn();
    const updateMany = vi.fn();
    const service = createGroupsService(stubPrisma({ delete: remove, updateMany }));

    const result = await service.remove(TEAM, "teknik");

    expect(result).toEqual({ removed: 3, retired: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("takes the subtree and leaves the siblings", async () => {
    // Reported as "deleting one group makes all the others disappear". It was
    // not this -- the wizard had quietly nested them all under one parent -- but
    // the blast radius of a delete is worth pinning either way.
    const remove = vi.fn();
    const service = createGroupsService(stubPrisma({ delete: remove }));

    const result = await service.remove(TEAM, "mekanik");

    expect(result).toEqual({ removed: 2, retired: 0 });
    expect(remove.mock.calls.map((call) => call[0].where.id).sort()).toEqual([
      "mekanik",
      "tasarim",
    ]);
  });

  it("deletes the deepest group first", async () => {
    // Group.parentId is RESTRICT, so removing Teknik while Mekanik still points
    // at it is refused. Order is the whole of the fix.
    const remove = vi.fn();
    const service = createGroupsService(stubPrisma({ delete: remove }));

    await service.remove(TEAM, "teknik");

    expect(remove.mock.calls.map((call) => call[0].where.id)).toEqual([
      "tasarim",
      "mekanik",
      "teknik",
    ]);
  });
});
