import { Prisma, type PrismaClient } from "@breakpoint/db";
import { OPEN_SPONSORSHIP_STATUSES } from "@breakpoint/types";

import { resolveSeasonId } from "../../lib/active-season";
import { ConflictError, NotFoundError } from "../../lib/http-errors";
import { paginated, toPrismaPage } from "../../lib/pagination";
import { assertAccountsBelongToTeam } from "../../lib/tenant";
import type {
  ConvertSponsorshipToFinanceInput,
  CreateOrganizationInput,
  CreateSponsorshipInput,
  ListOrganizationsQuery,
  ListSponsorshipsQuery,
  UpdateOrganizationInput,
  UpdateSponsorshipInput,
} from "./sponsors.schema";

// The finance side of the link (issue #26): whether this sponsorship has
// already been converted, and to what. Sponsorship carries no column of its
// own for this -- it exists only because FinanceTransaction.sponsorshipId
// points here, so the summary always comes in through the relation.
const financeTransactionLinkSelect = {
  id: true,
  amount: true,
  transactionDate: true,
} satisfies Prisma.FinanceTransactionSelect;

function serializeFinanceLink(
  link: Prisma.FinanceTransactionGetPayload<{ select: typeof financeTransactionLinkSelect }> | null
) {
  return link && { id: link.id, amount: link.amount.toFixed(2), transactionDate: link.transactionDate };
}

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
      financeTransaction: { select: financeTransactionLinkSelect },
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
  financeTransaction: { select: financeTransactionLinkSelect },
} satisfies Prisma.SponsorshipSelect;

type OrganizationRow = Prisma.OrganizationGetPayload<{ select: typeof organizationSelect }>;
type SponsorshipRow = Prisma.SponsorshipGetPayload<{ select: typeof sponsorshipSelect }>;

function serializeOrganization(organization: OrganizationRow) {
  return {
    ...organization,
    sponsorships: organization.sponsorships.map((entry) => ({
      ...entry,
      amount: entry.amount?.toFixed(2) ?? null,
      financeTransaction: serializeFinanceLink(entry.financeTransaction),
    })),
  };
}

function serializeSponsorship(sponsorship: SponsorshipRow) {
  const { organization, season, financeTransaction, ...rest } = sponsorship;
  return {
    ...rest,
    amount: sponsorship.amount?.toFixed(2) ?? null,
    organizationName: organization.name,
    organization,
    seasonName: season.name,
    financeTransaction: serializeFinanceLink(financeTransaction),
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

    /**
     * A sponsorship with income already booked against it cannot be deleted:
     * the finance record would be left pointing at nothing. The foreign key is
     * RESTRICT for the same reason removeOrganization's is -- this checks first
     * so the caller gets a 409 with an explanation instead of a raw P2003.
     */
    removeSponsorship: async (teamId: string, id: string) => {
      const existing = await prisma.sponsorship.findFirst({
        where: { id, teamId },
        select: { financeTransaction: { select: { id: true } } },
      });
      if (!existing) {
        throw new NotFoundError("Sponsorluk kaydi bulunamadi");
      }
      if (existing.financeTransaction) {
        throw new ConflictError(
          "Bu sponsorluk finans kaydina baglidir. Once bagli finans kaydini silin."
        );
      }
      await prisma.sponsorship.delete({ where: { id } });
    },

    /**
     * "Finansa isle": books a SPONSOR-status sponsorship's amount as team-wide
     * income, once.
     *
     * type, category and groupId are fixed here rather than accepted from the
     * caller -- this is the one place a sponsorship becomes a finance record,
     * and letting the client pick those would let a converted row masquerade
     * as an ordinary manual entry. seasonId and teamId come from the
     * sponsorship itself: the income belongs to the season the sponsorship was
     * for, not whichever season happens to be active when someone clicks the
     * button months later.
     *
     * The count check below gives a clear 409 in the ordinary case. It is not
     * the real guard -- two requests racing both read "not yet converted"
     * before either writes, so the actual protection is
     * FinanceTransaction.sponsorshipId's unique constraint, and the P2002 it
     * throws when the loser's insert lands is caught below and turned into the
     * same 409.
     */
    convertToFinanceTransaction: async (
      teamId: string,
      sponsorshipId: string,
      input: ConvertSponsorshipToFinanceInput,
      actorId: string
    ) => {
      const sponsorship = await prisma.sponsorship.findFirst({
        where: { id: sponsorshipId, teamId },
        select: {
          seasonId: true,
          status: true,
          financeTransaction: { select: { id: true } },
        },
      });
      if (!sponsorship) {
        throw new NotFoundError("Sponsorluk kaydi bulunamadi");
      }
      if (sponsorship.status !== "SPONSOR") {
        throw new ConflictError("Yalnizca SPONSOR durumundaki kayitlar finansa islenebilir");
      }
      if (sponsorship.financeTransaction) {
        throw new ConflictError("Bu sponsorluk zaten bir finans kaydina baglanmis");
      }

      try {
        const transaction = await prisma.financeTransaction.create({
          data: {
            teamId,
            seasonId: sponsorship.seasonId,
            groupId: null,
            type: "INCOME",
            category: "Sponsorluk",
            amount: new Prisma.Decimal(input.amount),
            transactionDate: input.transactionDate,
            description: input.description ?? null,
            createdById: actorId,
            sponsorshipId,
          },
          select: {
            id: true,
            seasonId: true,
            groupId: true,
            type: true,
            category: true,
            amount: true,
            description: true,
            transactionDate: true,
            sponsorshipId: true,
            createdAt: true,
          },
        });
        return { ...transaction, amount: transaction.amount.toFixed(2) };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new ConflictError("Bu sponsorluk zaten bir finans kaydina baglanmis");
        }
        throw error;
      }
    },
  };
}
