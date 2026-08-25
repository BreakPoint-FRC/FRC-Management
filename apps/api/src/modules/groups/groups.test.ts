import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@breakpoint/db";
import { buildApp } from "../../app";
import { groupDetailSchema } from "@breakpoint/types";
import {
  addGroupMemberSchema,
  createGroupSchema,
  updateGroupSchema,
} from "./groups.schema";
import { createGroupsService } from "./groups.service";

// Same shape as app.test.ts: a stub client whose $disconnect is a no-op, so
// app.close() never reaches a database.
function stubClient(overrides: Record<string, unknown>) {
  return { $disconnect: vi.fn().mockResolvedValue(undefined), ...overrides };
}

function buildWithPrisma(stub: unknown) {
  return buildApp({ prisma: stub as PrismaClient });
}

describe("groups.schema", () => {
  it("accepts a valid group payload", () => {
    const result = createGroupSchema.safeParse({ name: "Mechanical" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty group name", () => {
    const result = createGroupSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an update with no fields", () => {
    expect(updateGroupSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an update with an unrecognized field", () => {
    expect(updateGroupSchema.safeParse({ groupName: "x" }).success).toBe(false);
  });

  it("accepts a rename", () => {
    expect(updateGroupSchema.safeParse({ name: "Controls" }).success).toBe(true);
  });

  it("rejects a membership payload without a member id", () => {
    const result = addGroupMemberSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("groups routes", () => {
  it("lists groups by name", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const app = buildWithPrisma(stubClient({ group: { findMany } }));

    const response = await app.inject({ method: "GET", url: "/groups" });

    expect(response.statusCode).toBe(200);
    expect(findMany).toHaveBeenCalledWith({ orderBy: { name: "asc" } });

    await app.close();
  });

  it("returns the members and tasks of a group", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: "g1",
      name: "Software",
      members: [],
      tasks: [],
    });
    const app = buildWithPrisma(stubClient({ group: { findUnique } }));

    const response = await app.inject({ method: "GET", url: "/groups/g1" });

    expect(response.statusCode).toBe(200);
    // Group task management is the point of the detail route; without the
    // include it would answer with a bare group and the group page would need a
    // second round trip per relation.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "g1" },
      include: { members: { include: { member: true } }, tasks: true },
    });

    await app.close();
  });

  it("returns 404 when a group does not exist", async () => {
    const app = buildWithPrisma(
      stubClient({ group: { findUnique: vi.fn().mockResolvedValue(null) } })
    );

    const response = await app.inject({ method: "GET", url: "/groups/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      statusCode: 404,
      error: "Not Found",
      message: "Group not found",
    });

    await app.close();
  });

  it("creates a group with 201", async () => {
    const create = vi.fn().mockResolvedValue({ id: "g1", name: "Electrical" });
    const app = buildWithPrisma(stubClient({ group: { create } }));

    const response = await app.inject({
      method: "POST",
      url: "/groups",
      payload: { name: "Electrical" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "g1", name: "Electrical" });
    expect(create).toHaveBeenCalledWith({ data: { name: "Electrical" } });

    await app.close();
  });

  it("returns a structured 400 for an invalid group payload", async () => {
    const app = buildWithPrisma(stubClient({ group: { create: vi.fn() } }));

    const response = await app.inject({
      method: "POST",
      url: "/groups",
      payload: { name: "" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      statusCode: 400,
      error: "Bad Request",
      issues: expect.any(Array),
    });

    await app.close();
  });

  it("maps a duplicate group name to 409", async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`name`)",
      { code: "P2002", clientVersion: "7.9.1" }
    );
    const app = buildWithPrisma(
      stubClient({ group: { create: vi.fn().mockRejectedValue(duplicate) } })
    );

    const response = await app.inject({
      method: "POST",
      url: "/groups",
      payload: { name: "Software" },
    });

    expect(response.statusCode).toBe(409);

    await app.close();
  });

  it("renames a group", async () => {
    const update = vi.fn().mockResolvedValue({ id: "g1", name: "Controls" });
    const app = buildWithPrisma(stubClient({ group: { update } }));

    const response = await app.inject({
      method: "PATCH",
      url: "/groups/g1",
      payload: { name: "Controls" },
    });

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: { name: "Controls" },
    });

    await app.close();
  });

  it("adds a member to a group with 201", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ groupId: "g1", memberId: "m1" });
    const findFirst = vi.fn().mockResolvedValue({ id: "m1" });
    const app = buildWithPrisma(
      stubClient({ groupMember: { create }, member: { findFirst } })
    );

    const response = await app.inject({
      method: "POST",
      url: "/groups/g1/members",
      payload: { memberId: "m1" },
    });

    expect(response.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith({
      data: { groupId: "g1", memberId: "m1" },
    });

    await app.close();
  });

  it("maps an unknown member id on join to 400", async () => {
    const fkViolation = new Prisma.PrismaClientKnownRequestError(
      "Foreign key constraint failed on the field: `GroupMember_memberId_fkey`",
      { code: "P2003", clientVersion: "7.9.1" }
    );
    const app = buildWithPrisma(
      stubClient({
        groupMember: { create: vi.fn().mockRejectedValue(fkViolation) },
        member: { findFirst: vi.fn().mockResolvedValue({ id: "m1" }) },
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/groups/g1/members",
      payload: { memberId: "ghost" },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("removes a member from a group with 204", async () => {
    const remove = vi.fn().mockResolvedValue({});
    const app = buildWithPrisma(stubClient({ groupMember: { delete: remove } }));

    const response = await app.inject({
      method: "DELETE",
      url: "/groups/g1/members/m1",
    });

    expect(response.statusCode).toBe(204);
    expect(remove).toHaveBeenCalledWith({
      where: { groupId_memberId: { groupId: "g1", memberId: "m1" } },
    });

    await app.close();
  });

  it("returns 404 when removing a membership that is not there", async () => {
    const notFound = new Prisma.PrismaClientKnownRequestError(
      "An operation failed because it depends on one or more records that were required but not found.",
      { code: "P2025", clientVersion: "7.9.1" }
    );
    const app = buildWithPrisma(
      stubClient({
        groupMember: { delete: vi.fn().mockRejectedValue(notFound) },
      })
    );

    const response = await app.inject({
      method: "DELETE",
      url: "/groups/g1/members/m1",
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("deletes a group with 204", async () => {
    const app = buildWithPrisma(
      stubClient({
        $transaction: vi.fn().mockResolvedValue([{ count: 0 }, {}]),
        groupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        group: { delete: vi.fn().mockResolvedValue({}) },
      })
    );

    const response = await app.inject({ method: "DELETE", url: "/groups/g1" });

    expect(response.statusCode).toBe(204);

    await app.close();
  });

  it("maps deleting a group that does not exist to 404", async () => {
    const notFound = new Prisma.PrismaClientKnownRequestError(
      "An operation failed because it depends on one or more records that were required but not found.",
      { code: "P2025", clientVersion: "7.9.1" }
    );
    const app = buildWithPrisma(
      stubClient({
        $transaction: vi.fn().mockRejectedValue(notFound),
        groupMember: { deleteMany: vi.fn() },
        group: { delete: vi.fn() },
      })
    );

    const response = await app.inject({ method: "DELETE", url: "/groups/nope" });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("refuses to add an archived member to a group", async () => {
    // Members are soft-deleted, so the foreign key is satisfied and the join
    // row would be written happily — the roster would then show someone the
    // rest of the app reports as gone.
    const create = vi.fn();
    const findFirst = vi.fn().mockResolvedValue(null);
    const app = buildWithPrisma(
      stubClient({ groupMember: { create }, member: { findFirst } })
    );

    const response = await app.inject({
      method: "POST",
      url: "/groups/g1/members",
      payload: { memberId: "archived-member" },
    });

    expect(response.statusCode).toBe(404);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "archived-member", archivedAt: null },
    });
    expect(create).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects a PATCH that would change nothing", async () => {
    const update = vi.fn();
    const app = buildWithPrisma(stubClient({ group: { update } }));

    const response = await app.inject({
      method: "PATCH",
      url: "/groups/g1",
      payload: {},
    });

    // Regression guard: this used to reach Prisma with an empty `data` and
    // answer 200, so the caller could not tell a no-op from a rename.
    expect(response.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects a PATCH whose only field is misspelled", async () => {
    const update = vi.fn();
    const app = buildWithPrisma(stubClient({ group: { update } }));

    const response = await app.inject({
      method: "PATCH",
      url: "/groups/g1",
      payload: { groupName: "Controls" },
    });

    expect(response.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();

    await app.close();
  });
});

describe("groups.service delete", () => {
  // GroupMember.groupId is ON DELETE RESTRICT: deleting a group without first
  // clearing its memberships fails with a foreign key error. Doing it in two
  // separate awaits instead would half-apply when the group delete fails, so the
  // guard is both statements landing in one $transaction call.
  it("clears memberships and deletes the group in one transaction", async () => {
    const deleteMany = vi.fn().mockReturnValue("deleteMany-op");
    const del = vi.fn().mockReturnValue("delete-op");
    const $transaction = vi.fn().mockResolvedValue([{ count: 2 }, {}]);
    const prisma = {
      $transaction,
      groupMember: { deleteMany },
      group: { delete: del },
    } as unknown as PrismaClient;

    await createGroupsService(prisma).remove("g1");

    expect(deleteMany).toHaveBeenCalledWith({ where: { groupId: "g1" } });
    expect(del).toHaveBeenCalledWith({ where: { id: "g1" } });
    // Order matters as much as atomicity: the memberships have to be the first
    // statement, or the RESTRICT fires before they are gone.
    expect($transaction).toHaveBeenCalledWith(["deleteMany-op", "delete-op"]);
  });

  it("leaves tasks alone when a group is deleted", async () => {
    const $transaction = vi.fn().mockResolvedValue([{ count: 0 }, {}]);
    const taskDeleteMany = vi.fn();
    const taskUpdateMany = vi.fn();
    const prisma = {
      $transaction,
      groupMember: { deleteMany: vi.fn() },
      group: { delete: vi.fn() },
      task: { deleteMany: taskDeleteMany, updateMany: taskUpdateMany },
    } as unknown as PrismaClient;

    await createGroupsService(prisma).remove("g1");

    // Task.groupId is ON DELETE SET NULL, so the database detaches them; a task
    // must survive its group as a cross-group task rather than being deleted.
    expect(taskDeleteMany).not.toHaveBeenCalled();
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });
});

describe("groupDetailSchema", () => {
  // groupSchema would parse this successfully and hand back { id, name } only,
  // dropping exactly what the detail route exists to deliver.
  it("keeps the members and tasks of a group detail response", () => {
    const parsed = groupDetailSchema.parse({
      id: "g1",
      name: "Software",
      members: [
        {
          groupId: "g1",
          memberId: "m1",
          member: {
            id: "m1",
            name: "Ada Yilmaz",
            email: "ada@breakpoint.test",
            role: "ADMIN",
          },
        },
      ],
      tasks: [
        {
          id: "t1",
          title: "Write the autonomous routine",
          description: null,
          status: "TODO",
          groupId: "g1",
          assigneeId: "m1",
          dueAt: null,
        },
      ],
    });

    expect(parsed.members[0].member.name).toBe("Ada Yilmaz");
    expect(parsed.tasks[0].title).toBe("Write the autonomous routine");
  });
});
