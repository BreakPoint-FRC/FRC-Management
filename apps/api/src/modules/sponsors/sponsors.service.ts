import { Prisma, type PrismaClient } from "@breakpoint/db";
import { OPEN_SPONSORSHIP_STATUSES } from "@breakpoint/types";

import { resolveSeasonId } from "../../lib/active-season";
import { ConflictError, NotFoundError } from "../../lib/http-errors";
import { paginated, toPrismaPage } from "../../lib/pagination";
import { assertAccountsBelongToTeam } from "../../lib/tenant";
import type {
  CreateOrganizationInput,
  CreateSponsorshipInput,
  ListOrganizationsQuery,
  ListSponsorshipsQuery,
  UpdateOrganizationInput,
  UpdateSponsorshipInput,
} from "./sponsors.schema";

const organizationSelect = {
  id: true,
  name: true,
  website: true,
  email: true,
  phone: true,
  notes: true,
  sponsorships: {
    select: {
      id: true,
      status: true,
      amount: true,
      season: { select: { id: true, name: true } },
    },
    orderBy: { season: { startDate: "desc" } },
  },
} satisfies Prisma.OrganizationSelect;

const sponsorshipSelect = {
  id: true,
  organizationId: true,
  seasonId: true,
  status: true,
  amount: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  organization: { select: { name: true, website: true, email: true, phone: true } },
  season: { select: { name: true } },
  assignedTo: { select: { id: true, fullName: true } },
} satisfies Prisma.SponsorshipSelect;

type OrganizationRow = Prisma.OrganizationGetPayload<{ select: typeof organizationSelect }>;
type SponsorshipRow = Prisma.SponsorshipGetPayload<{ select: typeof sponsorshipSelect }>;

function serializeOrganization(organization: OrganizationRow) {
  return {
    ...organization,
    sponsorships: organization.sponsorships.map((entry) => ({
      ...entry,
      amount: entry.amount?.toFixed(2) ?? null,
    })),
  };
}

function serializeSponsorship(sponsorship: SponsorshipRow) {
  const { organization, season, ...rest } = sponsorship;
  return {
    ...rest,
    amount: sponsorship.amount?.toFixed(2) ?? null,
    organizationName: organization.name,
    organization,
    seasonName: season.name,
  };
}

export function createSponsorsService(prisma: PrismaClient) {
  return {
    listOrganizations: async (teamId: string, query: ListOrganizationsQuery) => {
      const where: Prisma.OrganizationWhereInput = {
        teamId,
        ...(query.search ? { name: { contains: query.search, mode: "insensitive" } } : {}),
      };

      const [rows, total] = await prisma.$transaction([
        prisma.organization.findMany({
          where,
          select: organizationSelect,
          orderBy: { name: "asc" },
          ...toPrismaPage(query),
        }),
        prisma.organization.count({ where }),
      ]);

      return paginated(rows.map(serializeOrganization), total, query);
    },

    // findFirst rather than findUnique: the team is half the identity now, and
    // (id, teamId) is not a unique index.
    getOrganization: async (teamId: string, id: string) => {
      const organization = await prisma.organization.findFirst({
        where: { id, teamId },
        select: organizationSelect,
      });
      return organization && serializeOrganization(organization);
    },

    createOrganization: async (teamId: string, input: CreateOrganizationInput) => {
      const organization = await prisma.organization.create({
        data: { ...input, teamId },
        select: organizationSelect,
      });
      return serializeOrganization(organization);
    },

    updateOrganization: async (teamId: string, id: string, input: UpdateOrganizationInput) => {
      const existing = await prisma.organization.count({ where: { id, teamId } });
      if (existing === 0) throw new NotFoundError("Firma bulunamadi");

      const organization = await prisma.organization.update({
        where: { id },
        data: input,
        select: organizationSelect,
      });
      return serializeOrganization(organization);
    },

    /**
     * Only a company with no sponsorship history can be removed.
     *
     * Once a firm has been approached in any season, that is a record of what
     * the team did, and the foreign key is RESTRICT for the same reason. A firm
     * the team has stopped dealing with gets an INACTIVE sponsorship, not a
     * deletion.
     */
    removeOrganization: async (teamId: string, id: string) => {
      const existing = await prisma.organization.count({ where: { id, teamId } });
      if (existing === 0) throw new NotFoundError("Firma bulunamadi");

      const count = await prisma.sponsorship.count({ where: { organizationId: id } });
      if (count > 0) {
        throw new ConflictError(
          `Bu firmanin ${count} sezonluk kaydi var, silinemez -- sponsorlugu INACTIVE yapin`
        );
      }
      await prisma.organization.delete({ where: { id } });
    },

    listSponsorships: async (teamId: string, query: ListSponsorshipsQuery) => {
      const where: Prisma.SponsorshipWhereInput = {
        teamId,
        ...(query.seasonId ? { seasonId: query.seasonId } : {}),
        ...(query.assignedToId ? { assignedToId: query.assignedToId } : {}),
        ...(query.status
          ? { status: query.status }
          : query.open
            ? { status: { in: [...OPEN_SPONSORSHIP_STATUSES] } }
            : {}),
      };

      const [rows, total] = await prisma.$transaction([
        prisma.sponsorship.findMany({
          where,
          select: sponsorshipSelect,
          orderBy: [{ status: "asc" }, { organization: { name: "asc" } }],
          ...toPrismaPage(query),
        }),
        prisma.sponsorship.count({ where }),
      ]);

      return paginated(rows.map(serializeSponsorship), total, query);
    },

    getSponsorship: async (teamId: string, id: string) => {
      const sponsorship = await prisma.sponsorship.findFirst({
        where: { id, teamId },
        select: sponsorshipSelect,
      });
      return sponsorship && serializeSponsorship(sponsorship);
    },

    /**
     * One relationship row per company per season.
     *
     * The unique index enforces it, but a bare P2002 says "a record with that
     * value already exists", which does not tell a lead that the firm is
     * already on this season's list and should be edited rather than re-added.
     */
    createSponsorship: async (
      teamId: string,
      { seasonId, amount, ...rest }: CreateSponsorshipInput
    ) => {
      const resolvedSeasonId = await resolveSeasonId(prisma, teamId, seasonId);

      // The company has to be this team's own. The unique index below is on
      // (organization, season) and would happily accept another team's firm.
      const organization = await prisma.organization.count({
        where: { id: rest.organizationId, teamId },
      });
      if (organization === 0) throw new NotFoundError("Firma bulunamadi");

      if (rest.assignedToId) {
        await assertAccountsBelongToTeam(prisma, teamId, [rest.assignedToId]);
      }

      const existing = await prisma.sponsorship.findUnique({
        where: {
          organizationId_seasonId: {
            organizationId: rest.organizationId,
            seasonId: resolvedSeasonId,
          },
        },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictError("Bu firmanin bu sezon icin kaydi zaten var");
      }

      const sponsorship = await prisma.sponsorship.create({
        data: {
          ...rest,
          teamId,
          seasonId: resolvedSeasonId,
          amount: amount ? new Prisma.Decimal(amount) : null,
        },
        select: sponsorshipSelect,
      });
      return serializeSponsorship(sponsorship);
    },

    updateSponsorship: async (
      teamId: string,
      id: string,
      { amount, ...rest }: UpdateSponsorshipInput
    ) => {
      const existing = await prisma.sponsorship.count({ where: { id, teamId } });
      if (existing === 0) throw new NotFoundError("Sponsorluk kaydi bulunamadi");

      if (rest.assignedToId) {
        await assertAccountsBelongToTeam(prisma, teamId, [rest.assignedToId]);
      }

      const sponsorship = await prisma.sponsorship.update({
        where: { id },
        data: {
          ...rest,
          // `undefined` leaves it alone; an explicit null clears it. A pledge
          // that was withdrawn has to be expressible.
          ...(amount === undefined ? {} : { amount: amount ? new Prisma.Decimal(amount) : null }),
        },
        select: sponsorshipSelect,
      });
      return serializeSponsorship(sponsorship);
    },

    removeSponsorship: async (teamId: string, id: string) => {
      const existing = await prisma.sponsorship.count({ where: { id, teamId } });
      if (existing === 0) throw new NotFoundError("Sponsorluk kaydi bulunamadi");
      await prisma.sponsorship.delete({ where: { id } });
    },
  };
}
