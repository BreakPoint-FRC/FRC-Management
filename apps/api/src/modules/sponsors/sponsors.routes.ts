import type { FastifyInstance } from "fastify";

import { authorize } from "../../lib/authorize";
import { NotFoundError } from "../../lib/http-errors";
import {
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
 *   DELETE /sponsors/sponsorships/:id                -> 204 | 401 | 403 | 404
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

  // --- Organizations -------------------------------------------------------

  // -> 200 | 400 | 401 | 403
  app.get("/organizations", async (req) => {
    const query = listOrganizationsQuerySchema.parse(req.query);
    await require(req.account.id, "read");
    return service.listOrganizations(query);
  });

  // -> 200 | 401 | 403 | 404
  app.get("/organizations/:id", async (req) => {
    const { id } = req.params as { id: string };
    await require(req.account.id, "read");

    const organization = await service.getOrganization(id);
    if (!organization) throw new NotFoundError("Firma bulunamadi");
    return organization;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/organizations", async (req, reply) => {
    await require(req.account.id, "create");

    const organization = await service.createOrganization(
      createOrganizationSchema.parse(req.body)
    );
    reply.code(201).send(organization);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/organizations/:id", async (req) => {
    const { id } = req.params as { id: string };
    await require(req.account.id, "update");

    return service.updateOrganization(id, updateOrganizationSchema.parse(req.body));
  });

  // -> 204 | 401 | 403 | 404 | 409
  app.delete("/organizations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await require(req.account.id, "delete");

    await service.removeOrganization(id);
    reply.code(204).send();
  });

  // --- Sponsorships --------------------------------------------------------

  // -> 200 | 400 | 401 | 403
  app.get("/sponsorships", async (req) => {
    const query = listSponsorshipsQuerySchema.parse(req.query);
    await require(req.account.id, "read");
    return service.listSponsorships(query);
  });

  // -> 200 | 401 | 403 | 404
  app.get("/sponsorships/:id", async (req) => {
    const { id } = req.params as { id: string };
    await require(req.account.id, "read");

    const sponsorship = await service.getSponsorship(id);
    if (!sponsorship) throw new NotFoundError("Sponsorluk kaydi bulunamadi");
    return sponsorship;
  });

  // -> 201 | 400 | 401 | 403 | 409
  app.post("/sponsorships", async (req, reply) => {
    await require(req.account.id, "create");

    const sponsorship = await service.createSponsorship(
      createSponsorshipSchema.parse(req.body)
    );
    reply.code(201).send(sponsorship);
  });

  // -> 200 | 400 | 401 | 403 | 404
  app.patch("/sponsorships/:id", async (req) => {
    const { id } = req.params as { id: string };
    await require(req.account.id, "update");

    return service.updateSponsorship(id, updateSponsorshipSchema.parse(req.body));
  });

  // -> 204 | 401 | 403 | 404
  app.delete("/sponsorships/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await require(req.account.id, "delete");

    await service.removeSponsorship(id);
    reply.code(204).send();
  });
}
