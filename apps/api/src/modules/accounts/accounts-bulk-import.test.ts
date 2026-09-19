import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { NotFoundError } from "../../lib/http-errors";
import { createAccountsService } from "./accounts.service";

const TEAM = "team-1";

const ROLES = [
  { id: "role-member", name: "Üye", placement: "TEAM_WIDE" },
  { id: "role-lead", name: "Lead", placement: "IN_GROUP" },
];

/**
 * A tiny in-memory account table, so duplicate-in-db checks are real queries
 * against real state rather than a canned answer -- including, for the race
 * test, state that changes between the calls a single commit makes.
 */
function stubPrisma(options: { existingEmails?: string[]; findManyResponses?: string[][] } = {}) {
  const accounts = new Map<string, { id: string; email: string }>();
  for (const email of options.existingEmails ?? []) {
    accounts.set(email, { id: `seed-${email}`, email });
  }
  let nextId = 1;
  let findManyCall = 0;

  const auditLogs: Array<{ entityId: string; newValue: Record<string, unknown> }> = [];
  const accountRoleCreateMany = vi.fn();
  const groupMembershipUpsert = vi.fn();

  const stub = {
    account: {
      findMany: async ({ where }: { where: { email: { in: string[] } } }) => {
        // Lets a test script a specific sequence of answers -- used to
        // simulate a concurrent insert landing between the pre-check and the
        // in-transaction re-check of the same commit.
        if (options.findManyResponses) {
          const scripted = options.findManyResponses[findManyCall] ?? [];
          findManyCall += 1;
          return scripted.map((email) => ({ email }));
        }
        return where.email.in.filter((email) => accounts.has(email)).map((email) => ({ email }));
      },
      create: async ({ data }: { data: { email: string } }) => {
        const id = `account-${nextId++}`;
        accounts.set(data.email, { id, email: data.email });
        return { id };
      },
    },
    role: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        ROLES.filter((role) => where.id.in.includes(role.id)),
    },
    group: { count: async () => 1 },
    accountRole: { deleteMany: vi.fn(), createMany: accountRoleCreateMany },
    groupMembership: { upsert: groupMembershipUpsert },
    auditLog: {
      create: vi.fn(({ data }: { data: { entityId: string; newValue: Record<string, unknown> } }) => {
        auditLogs.push(data);
      }),
    },
  };

  const full = Object.assign(stub, {
    $transaction: async (work: unknown) =>
      Array.isArray(work) ? Promise.all(work) : (work as (tx: typeof stub) => unknown)(full),
  }) as unknown as PrismaClient;

  return { prisma: full, accounts, auditLogs, accountRoleCreateMany, groupMembershipUpsert };
}

const csv = (rows: string) => `fullName,email\n${rows}\n`;

describe("bulk import preview", () => {
  it("passes a clean batch", async () => {
    const { prisma } = stubPrisma();
    const service = createAccountsService(prisma);

    const result = await service.previewBulkImport(
      csv("Ada Yılmaz,ada@example.com\nKerem Kaya,kerem@example.com")
    );

    expect(result.fileError).toBeNull();
    expect(result.valid).toBe(true);
    expect(result.rows.map((row) => row.status)).toEqual(["ok", "ok"]);
  });

  it("flags every occurrence of an email repeated in the file", async () => {
    const { prisma } = stubPrisma();
    const service = createAccountsService(prisma);

    const result = await service.previewBulkImport(
      csv("Ada Yılmaz,ada@example.com\nAda Y.,ada@example.com")
    );

    expect(result.valid).toBe(false);
    expect(result.rows.map((row) => row.status)).toEqual(["duplicate_in_file", "duplicate_in_file"]);
  });

  it("flags an email that already exists on the platform", async () => {
    const { prisma } = stubPrisma({ existingEmails: ["ada@example.com"] });
    const service = createAccountsService(prisma);

    const result = await service.previewBulkImport(csv("Ada Yılmaz,ada@example.com"));

    expect(result.valid).toBe(false);
    expect(result.rows[0]).toMatchObject({ status: "duplicate_in_db" });
  });

  it("flags a malformed email without touching the database", async () => {
    const { prisma, accounts } = stubPrisma();
    const service = createAccountsService(prisma);

    const result = await service.previewBulkImport(csv("Ada Yılmaz,not-an-email"));

    expect(result.valid).toBe(false);
    expect(result.rows[0]).toMatchObject({ status: "invalid" });
    expect(result.rows[0]?.issues.length).toBeGreaterThan(0);
    expect(accounts.size).toBe(0);
  });

  it("flags a blank name", async () => {
    const { prisma } = stubPrisma();
    const service = createAccountsService(prisma);

    const result = await service.previewBulkImport(csv(",ada@example.com"));

    expect(result.rows[0]).toMatchObject({ status: "invalid" });
  });

  it("surfaces a file-level error instead of a row list for a bad header", async () => {
    const { prisma } = stubPrisma();
    const service = createAccountsService(prisma);

    const result = await service.previewBulkImport("name,mail\nAda,ada@example.com\n");

    expect(result.valid).toBe(false);
    expect(result.fileError).toMatch(/Başlık/);
    expect(result.rows).toEqual([]);
  });
});

describe("bulk import commit", () => {
  it("creates every row, hashes a distinct password each, and shares one batchId across their audit entries", async () => {
    const { prisma, accounts, auditLogs } = stubPrisma();
    const service = createAccountsService(prisma);

    const result = await service.commitBulkImport(
      TEAM,
      csv("Ada Yılmaz,ada@example.com\nKerem Kaya,kerem@example.com"),
      [],
      "admin-1"
    );

    expect(result.committed).toBe(true);
    if (!result.committed) return;

    expect(result.created).toHaveLength(2);
    expect(accounts.size).toBe(2);

    const passwords = result.created.map((row) => row.temporaryPassword);
    expect(new Set(passwords).size).toBe(2);
    for (const password of passwords) expect(password.length).toBeGreaterThanOrEqual(10);

    expect(auditLogs).toHaveLength(2);
    const batchIds = new Set(auditLogs.map((entry) => entry.newValue.batchId));
    expect(batchIds.size).toBe(1);
    expect([...batchIds][0]).toBe(result.batchId);

    // Individually traceable: each account keeps its own entityId, not a
    // shared one for the whole batch.
    const entityIds = new Set(auditLogs.map((entry) => entry.entityId));
    expect(entityIds.size).toBe(2);

    // The password is the one thing that must never reach the audit trail.
    for (const entry of auditLogs) {
      expect(Object.keys(entry.newValue)).not.toContain("password");
      expect(Object.keys(entry.newValue)).not.toContain("temporaryPassword");
      expect(JSON.stringify(entry.newValue)).not.toContain(result.created[0]!.temporaryPassword);
    }
  });

  it("writes nothing and reports duplicate_in_file when the file repeats an email", async () => {
    const { prisma, accounts, accountRoleCreateMany } = stubPrisma();
    const service = createAccountsService(prisma);

    const result = await service.commitBulkImport(
      TEAM,
      csv("Ada Yılmaz,ada@example.com\nAda Y.,ada@example.com"),
      [],
      "admin-1"
    );

    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.rows.every((row) => row.status === "duplicate_in_file")).toBe(true);
    expect(accounts.size).toBe(0);
    expect(accountRoleCreateMany).not.toHaveBeenCalled();
  });

  it("assigns the chosen roles to every created account", async () => {
    const { prisma, accountRoleCreateMany, groupMembershipUpsert } = stubPrisma();
    const service = createAccountsService(prisma);

    const result = await service.commitBulkImport(
      TEAM,
      csv("Ada Yılmaz,ada@example.com\nKerem Kaya,kerem@example.com"),
      [{ roleId: "role-lead", groupId: "group-1" }],
      "admin-1"
    );

    expect(result.committed).toBe(true);
    expect(accountRoleCreateMany).toHaveBeenCalledTimes(2);
    expect(groupMembershipUpsert).toHaveBeenCalledTimes(2);
  });

  it("refuses a role id from outside the team before writing anything", async () => {
    const { prisma, accounts } = stubPrisma();
    const service = createAccountsService(prisma);

    await expect(
      service.commitBulkImport(TEAM, csv("Ada Yılmaz,ada@example.com"), [{ roleId: "role-foreign" }], "admin-1")
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(accounts.size).toBe(0);
  });

  it("does not trust a stale preview: re-validates and refuses a row that is invalid now", async () => {
    // Nothing about commitBulkImport is told a preview ever ran -- it always
    // re-derives valid/invalid from the raw CSV it is given.
    const { prisma } = stubPrisma({ existingEmails: ["ada@example.com"] });
    const service = createAccountsService(prisma);

    const result = await service.commitBulkImport(TEAM, csv("Ada Yılmaz,ada@example.com"), [], "admin-1");

    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.rows[0]).toMatchObject({ status: "duplicate_in_db" });
  });

  it("loses a race to a concurrent insert, rolls back, and returns a fresh preview instead of a bare error", async () => {
    // Three account.findMany calls happen for this one commit: the outer
    // pre-check (nothing taken yet), the in-transaction re-check (now taken --
    // this is the simulated race), and the fresh validateBulkImport the catch
    // block runs afterward (still taken, so the row now reads duplicate_in_db).
    const { prisma, accountRoleCreateMany } = stubPrisma({
      findManyResponses: [[], ["ada@example.com"], ["ada@example.com"]],
    });
    const service = createAccountsService(prisma);

    const result = await service.commitBulkImport(TEAM, csv("Ada Yılmaz,ada@example.com"), [], "admin-1");

    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.rows[0]).toMatchObject({ status: "duplicate_in_db" });
    expect(accountRoleCreateMany).not.toHaveBeenCalled();
  });
});
