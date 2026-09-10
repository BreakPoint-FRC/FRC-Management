import type { FastifyInstance } from "fastify";

import { authorize, canPerform } from "../../lib/authorize";
import { requireTeam } from "../../lib/tenant";
import { NotFoundError } from "../../lib/http-errors";
import {
  convertSponsorshipToFinanceSchema,
  createOrganizationSchema,
  createSponsorshipSchema,
  listOrganizationsQuerySchema,
  listSponsorshipsQuerySchema,
  updateOrganizationSchema,
  updateSponsorshipSchema,
} from "./sponsors.schema";
import { createSponsorsService } from "./sponsors.service";

/**
 * Mounted at /sponsors.
 *
 *   GET    /sponsors/organizations      ?page&pageSize&search
 *                                                    -> 200 paginated | 400 | 401 | 403
 *   GET    /sponsors/organizations/:id               -> 200 | 401 | 403 | 404
 *   POST   /sponsors/organizations { name, website?, email?, phone?, notes? }
 *                                                    -> 201 | 400 | 401 | 403 | 409 duplicate name
 *   PATCH  /sponsors/organizations/:id               -> 200 | 400 | 401 | 403 | 404
 *   DELETE /sponsors/organizations/:id               -> 204 | 401 | 403 | 404 | 409 has history
 *
 *   GET    /sponsors/sponsorships ?page&pageSize&seasonId&status&assignedToId&open
 *                                                    -> 200 paginated | 400 | 401 | 403
 *   GET    /sponsors/sponsorships/:id                -> 200 | 401 | 403 | 404
 *   POST   /sponsors/sponsorships { organizationId, seasonId?, status?, amount?, assignedToId?, notes? }
 *                                                    -> 201 | 400 | 401 | 403 | 409 already this season
 *   PATCH  /sponsors/sponsorships/:id                -> 200 | 400 | 401 | 403 | 404
 *   DELETE /sponsors/sponsorships/:id                -> 204 | 401 | 403 | 404 | 409 has finance link
 *
 *   POST   /sponsors/sponsorships/:id/finance-transaction { amount, transactionDate, description? }
 *     "Finansa isle" -- books a SPONSOR-status sponsorship as team-wide income.
 *     Requires SPONSORS/read + FINANCE/create (not SPONSORS/update: the
 *     sponsorship row itself is never written by this call).
 *                                                    -> 201 | 400 | 401 | 403 | 404 | 409 not SPONSOR or already linked
 *
 * A company and its relationship with the team are separate on purpose: the
 * firm's phone number does not change when the season does, and the same firm
 * can be a candidate in 2026 and a sponsor in 2027 without either record
 * overwriting the other.
 *
 * Sponsors are not owned by a department, so none of these pass a groupId. In
 * practice SPONSORS is enabled for Business and Media, and the roles that hold
 * it are the social director, the president and the leads of those groups
 * through their global roles.
 */
export async function sponsorsRoutes(app: FastifyInstance) {
  const service = createSponsorsService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  const require = (accountId: string, action: "read" | "create" | "update" | "delete") =>
    authorize(app.prisma, { accountId, tool: "SPONSORS", action });

  // FINANCE is a different module from SPONSORS: the amount and date on a
  // converted sponsorship are finance data, and an account with only
  // SPONSORS/read must not learn them by asking here instead of /finance.
  // Team-wide (no groupId) because a converted transaction always is -- see
  // convertToFinanceTransaction. Whether the sponsorship was converted at all
  // stays visible regardless; only the amount and date are withheld.
  const mayReadFinance = (accountId: string) =>
    canPerform(app.prisma, { accountId, tool: "FINANCE", action: "read" });

  // --- Organizations -------------------------------------------------------

  // -> 200 | 400 | 401 | 403
  app.get("/organizations", async (req) => {
    const query = listOrganizationsQuerySchema.parse(req.query);
    await require(req.account.id, "read");
    return service.listOrganizations(
      requireTeam(req.account),
      query,
      await mayReadFinance(req.account.id)
    );
  });

  // -> 200 | 401 | 403 | 404
  app.get("/organizations/:id", async (req) => {
    const { id } = req.params as { id: string };
    await require(req.account.id, "read");

    const organization = await service.getOrganization(
      requireTeam(req.account),
      id,
      await mayReadFinance(req.account.id)
    );
    if (!organization) throw new NotFoundError("Firma bulunamadi");
    return organization;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/organizations", async (req, reply) => {
    await require(req.account.id, "create");

    const organization = await service.createOrganization(
      requireTeam(req.account),
      createOrganizationSchema.parse(req.body),
      await mayReadFinance(req.account.id)
    );
    reply.code(201).send(organization);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/organizations/:id", async (req) => {
    const { id } = req.params as { id: string };
    await require(req.account.id, "update");

    return service.updateOrganization(
      requireTeam(req.account),
      id,
      updateOrganizationSchema.parse(req.body),
      await mayReadFinance(req.account.id)
    );
  });

  // -> 204 | 401 | 403 | 404 | 409
  app.delete("/organizations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await require(req.account.id, "delete");

    await service.removeOrganization(requireTeam(req.account), id);
    reply.code(204).send();
  });

  // --- Sponsorships --------------------------------------------------------

  // -> 200 | 400 | 401 | 403
  app.get("/sponsorships", async (req) => {
    const query = listSponsorshipsQuerySchema.parse(req.query);
    await require(req.account.id, "read");
    return service.listSponsorships(
      requireTeam(req.account),
      query,
      await mayReadFinance(req.account.id)
    );
  });

  // -> 200 | 401 | 403 | 404
  app.get("/sponsorships/:id", async (req) => {
    const { id } = req.params as { id: string };
    await require(req.account.id, "read");

    const sponsorship = await service.getSponsorship(
      requireTeam(req.account),
      id,
      await mayReadFinance(req.account.id)
    );
    if (!sponsorship) throw new NotFoundError("Sponsorluk kaydi bulunamadi");
    return sponsorship;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/sponsorships", async (req, reply) => {
    await require(req.account.id, "create");

    const sponsorship = await service.createSponsorship(
      requireTeam(req.account),
      createSponsorshipSchema.parse(req.body),
      await mayReadFinance(req.account.id)
    );
    reply.code(201).send(sponsorship);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/sponsorships/:id", async (req) => {
    const { id } = req.params as { id: string };
    await require(req.account.id, "update");

    return service.updateSponsorship(
      requireTeam(req.account),
      id,
      updateSponsorshipSchema.parse(req.body),
      await mayReadFinance(req.account.id)
    );
  });

  // -> 204 | 401 | 403 | 404 | 409
  app.delete("/sponsorships/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await require(req.account.id, "delete");

    await service.removeSponsorship(requireTeam(req.account), id);
    reply.code(204).send();
  });

  // -> 201 | 400 | 401 | 403 | 404 | 409
  //
  // SPONSORS/read rather than /update: converting does not write the
  // Sponsorship row, so a captain or mentor with only read access on
  // sponsorships can still turn a closed deal into income. FINANCE/create is
  // checked with no groupId, because the resulting transaction is always
  // team-wide (see convertToFinanceTransaction) -- a role whose FINANCE grant
  // is scoped to one department cannot use this endpoint, by design.
  app.post("/sponsorships/:id/finance-transaction", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = convertSponsorshipToFinanceSchema.parse(req.body);

    await require(req.account.id, "read");
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "FINANCE",
      action: "create",
    });

    const transaction = await service.convertToFinanceTransaction(
      requireTeam(req.account),
      id,
      input,
      req.account.id
    );
    reply.code(201).send(transaction);
  });
}
