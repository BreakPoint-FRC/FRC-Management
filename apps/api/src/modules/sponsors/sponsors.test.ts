import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { NotFoundError } from "../../lib/http-errors";
import { createOrganizationSchema } from "./sponsors.schema";
import { createSponsorsService } from "./sponsors.service";

const TEAM = "team-1";

describe("organization website", () => {
  // website ends up rendered as a real <a href> on the sponsors page. Zod's
  // own .url() accepts "javascript:..." as a well-formed URL -- WHATWG says
  // so -- so the scheme itself has to be checked, not just parseability.
  it("accepts an http(s) address", () => {
    expect(createOrganizationSchema.safeParse({ name: "Acme", website: "https://acme.test" }).success).toBe(
      true
    );
  });

  it("refuses a javascript: URI", () => {
    const result = createOrganizationSchema.safeParse({
      name: "Acme",
      website: "javascript:alert(document.cookie)",
    });
    expect(result.success).toBe(false);
  });
});

describe("sponsorship owners", () => {
  it("rejects a cross-team owner before creating a sponsorship", async () => {
    const findDuplicate = vi.fn();
    const create = vi.fn();
    const prisma = {
      season: { findFirst: async () => ({ id: "season-1" }) },
      organization: { count: async () => 1 },
      account: { count: async () => 0 },
      sponsorship: { findUnique: findDuplicate, create },
    } as unknown as PrismaClient;

    await expect(
      createSponsorsService(prisma).createSponsorship(TEAM, {
        organizationId: "organization-1",
        status: "CANDIDATE",
        assignedToId: "other-team-account",
      })
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(findDuplicate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a cross-team owner before updating a sponsorship", async () => {
    const update = vi.fn();
    const prisma = {
      sponsorship: { count: async () => 1, update },
      account: { count: async () => 0 },
    } as unknown as PrismaClient;

    await expect(
      createSponsorsService(prisma).updateSponsorship(TEAM, "sponsorship-1", {
        assignedToId: "other-team-account",
      })
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(update).not.toHaveBeenCalled();
  });
});
