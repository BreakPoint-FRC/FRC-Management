import type { FastifyInstance } from "fastify";
import type { ToolKey, TeamSetupStage } from "@breakpoint/types";

import { authorize } from "../../lib/authorize";
import { requireTeam } from "../../lib/tenant";
import { goToStageSchema, namingSchema } from "./setup.schema";
import { createSetupService } from "./setup.service";

/**
 * Mounted at /setup. The first-run flow a team admin lands in.
 *
 *   GET   /setup                                    -> 200 | 401 | 403
 *   POST  /setup/advance                            -> 200 | 401 | 403 | 409 not finished
 *   POST  /setup/back      { stage }                -> 200 | 400 | 401 | 403 | 409 not behind
 *   PUT   /setup/naming    { name, seasonName, seasonStartDate, seasonEndDate }
 *                                                   -> 200 | 400 | 401 | 403
 *   POST  /setup/template                           -> 200 | 401 | 403 | 409 roles exist
 *
 * This module owns the *order* and nothing else. Groups, roles, tools,
 * permissions and accounts are created through their own endpoints, with their
 * own validation -- a second write path for any of them would have to
 * re-implement the invariants in docs/authorization.md, and would eventually
 * get one of them wrong.
 *
 * Each step is written as it is completed, so a team admin who closes the tab
 * resumes where they stopped.
 */

/**
 * The tool each step is gated on.
 *
 * Advancing past a step is an act of the same weight as doing the work in it,
 * so it is authorized against the same tool rather than against a wizard
 * permission that would be a second way to describe the same authority.
 */
const STAGE_TOOL: Record<TeamSetupStage, ToolKey> = {
  GROUPS: "GROUPS",
  ROLES: "ROLES",
  TOOLS: "TOOLS",
  PERMISSIONS: "PERMISSIONS",
  NAMING: "SEASONS",
  ACCOUNTS: "ACCOUNTS",
  DONE: "ACCOUNTS",
};

export async function setupRoutes(app: FastifyInstance) {
  const service = createSetupService(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // Readable by anyone who may read the team structure: the sidebar has to know
  // whether to send this account to the wizard, and that is not privileged.
  // -> 200 | 401 | 403
  app.get("/", async (req) => {
    await authorize(app.prisma, { accountId: req.account.id, tool: "GROUPS", action: "read" });
    return service.state(requireTeam(req.account));
  });

  // -> 200 | 401 | 403 | 409
  app.post("/advance", async (req) => {
    const teamId = requireTeam(req.account);
    const { stage } = await service.state(teamId);
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: STAGE_TOOL[stage],
      action: "update",
    });
    return service.advance(teamId);
  });

  // -> 200 | 400 | 401 | 403 | 409
  app.post("/back", async (req) => {
    const teamId = requireTeam(req.account);
    const { stage } = goToStageSchema.parse(req.body);
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: STAGE_TOOL[stage],
      action: "update",
    });
    return service.goBack(teamId, stage);
  });

  // Gated on SEASONS: this writes the first season as well as the name, and the
  // season is the part that decides whether the dashboard works at all.
  // -> 200 | 400 | 401 | 403
  app.put("/naming", async (req) => {
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "SEASONS",
      action: "create",
    });
    return service.naming(requireTeam(req.account), namingSchema.parse(req.body));
  });

  // Creating a tree of roles with a matrix attached, so it is gated on
  // PERMISSIONS -- the heavier of the two things it writes.
  // -> 200 | 401 | 403 | 409
  app.post("/template", async (req) => {
    await authorize(app.prisma, {
      accountId: req.account.id,
      tool: "PERMISSIONS",
      action: "create",
    });
    return service.applyTemplate(requireTeam(req.account));
  });
}
