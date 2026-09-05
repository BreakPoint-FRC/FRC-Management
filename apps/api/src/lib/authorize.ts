import type { PrismaClient } from "@breakpoint/db";
import {
  EMPTY_PERMISSIONS,
  PERMISSION_FLAG,
  expandGroupSubtrees,
  groupAncestorPath,
  isPlatformOnlyTool,
  mergePermissions,
  type PermissionAction,
  type PermissionSet,
  type RolePlacement,
  type ToolKey,
} from "@breakpoint/types";

import { ForbiddenError, NotFoundError, UnauthorizedError } from "./http-errors";

export interface AuthorizationRequest {
  accountId: string;
  tool: ToolKey;
  action: PermissionAction;
  /**
   * The department the request is about.
   *
   * Omitted or null means the request is not scoped to one -- an administrative
   * action, or a record that belongs to no department such as a cross-group
   * task or a team-wide meeting. Only a TEAM_WIDE or EXTERNAL role can
   * authorize those: every other placement takes its authority from a group,
   * and there is no group here to take it from.
   */
  groupId?: string | null;
}

type GroupNode = { id: string; parentId: string | null };

/**
 * Everything a permission decision needs, loaded once.
 *
 * `authorize` and `resolvePermissionMatrix` both build one of these and then
 * apply the same rules to it. They used to duplicate the rules and carry a
 * comment telling the next person to change both; sharing the resolution is
 * what makes that comment unnecessary.
 */
interface AccessContext {
  /** null for a platform system admin, who belongs to no team. */
  teamId: string | null;
  /** The groups of that team, for expanding scopes and inheriting tools. */
  groups: GroupNode[];
  /** parentRoleId -> childRoleIds. */
  childrenOfRole: Map<string, string[]>;
  /**
   * Roles that authorize a request with no group: TEAM_WIDE and EXTERNAL.
   *
   * They are the bypass. A team admin is not a member of every department and
   * must not have to be; neither is a mentor who reads everything. It is
   * deliberately the only bypass in the system -- there is no hard-coded
   * "if admin" anywhere else.
   */
  teamWideRoleIds: Set<string>;
  /** groupId -> the roles that carry authority over it, membership included. */
  roleIdsByGroup: Map<string, Set<string>>;
  /** "groupId:toolId" -> isEnabled, as stored. Inheritance is resolved on read. */
  groupToolRows: Map<string, boolean>;
}

/**
 * Loads the account, its team, and everything the two of them can reach.
 *
 * Throws the 401 -- an account that is gone, suspended or archived is an
 * identity problem, and it is the only 401 in this file. Everything after it is
 * a 403, which tells a client something different: the credential is fine and
 * the answer is still no.
 */
async function loadContext(prisma: PrismaClient, accountId: string): Promise<AccessContext> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      teamId: true,
      isActive: true,
      archivedAt: true,
      team: { select: { isActive: true } },
      roles: {
        where: { isActive: true },
        select: {
          groupId: true,
          role: {
            select: {
              id: true,
              placement: true,
              groupScopes: { select: { groupId: true } },
            },
          },
        },
      },
      memberships: { where: { isActive: true }, select: { groupId: true } },
    },
  });

  if (
    !account ||
    !account.isActive ||
    account.archivedAt !== null ||
    (account.team !== null && !account.team.isActive)
  ) {
    throw new UnauthorizedError("Hesap aktif degil");
  }

  const [groups, edges, groupTools] = await Promise.all([
    // A platform admin has no team, and therefore no groups to scope anything
    // to. Only its TEAM_WIDE role matters, and that one never consults a group.
    account.teamId === null
      ? Promise.resolve([] as GroupNode[])
      : prisma.group.findMany({
          where: { teamId: account.teamId },
          select: { id: true, parentId: true },
        }),
    // One row per "is above" relationship -- dozens at most -- loaded whole and
    // walked in memory. The walk needs arbitrary depth, so this beats a
    // recursive CTE or a query per level on every authorized request.
    prisma.roleHierarchy.findMany({ select: { parentRoleId: true, childRoleId: true } }),
    account.teamId === null
      ? Promise.resolve([])
      : prisma.groupTool.findMany({
          where: { group: { teamId: account.teamId } },
          select: { groupId: true, toolId: true, isEnabled: true },
        }),
  ]);

  const childrenOfRole = new Map<string, string[]>();
  for (const edge of edges) {
    const children = childrenOfRole.get(edge.parentRoleId);
    if (children) children.push(edge.childRoleId);
    else childrenOfRole.set(edge.parentRoleId, [edge.childRoleId]);
  }

  const memberOf = new Set(account.memberships.map((row) => row.groupId));
  const teamWideRoleIds = new Set<string>();
  const roleIdsByGroup = new Map<string, Set<string>>();

  const cover = (groupId: string, roleId: string) => {
    const held = roleIdsByGroup.get(groupId);
    if (held) held.add(roleId);
    else roleIdsByGroup.set(groupId, new Set([roleId]));
  };

  for (const entry of account.roles) {
    const placement = entry.role.placement as RolePlacement;

    if (placement === "TEAM_WIDE" || placement === "EXTERNAL") {
      teamWideRoleIds.add(entry.role.id);
      if (placement === "TEAM_WIDE") {
        // TEAM_WIDE covers every group of the team as well as the group-less
        // records. EXTERNAL deliberately covers none: a mentor is attached to
        // the team, not to its structure.
        for (const group of groups) cover(group.id, entry.role.id);
      }
      continue;
    }

    if (placement === "IN_GROUP") {
      // The only placement still scoped by the assignment, and the only one
      // that needs a membership row. Without that check a freshly removed
      // member would keep working through a role nobody thought to revoke.
      if (entry.groupId !== null && memberOf.has(entry.groupId)) {
        cover(entry.groupId, entry.role.id);
      }
      continue;
    }

    // MANAGES_GROUP and ABOVE_GROUPS carry their own coverage, so no membership
    // is required. RoleGroupScope stores the roots; the subtree under each is
    // resolved here, which is why scoping a director to Teknik also reaches
    // Tasarim three levels down without anyone writing that row.
    const roots = entry.role.groupScopes.map((scope) => scope.groupId);
    for (const groupId of expandGroupSubtrees(roots, groups)) cover(groupId, entry.role.id);
  }

  return {
    teamId: account.teamId,
    groups,
    childrenOfRole,
    teamWideRoleIds,
    roleIdsByGroup,
    groupToolRows: new Map(
      groupTools.map((row) => [`${row.groupId}:${row.toolId}`, row.isEnabled])
    ),
  };
}

/**
 * Whether a department may use a tool, inheriting the answer from its parents.
 *
 * The nearest group up the chain that states an answer wins, so enabling
 * MEETINGS on Teknik switches it on for Mekanik and Tasarim underneath, and
 * Tasarim can still write its own row to turn it back off.
 *
 * No row anywhere up the chain is a no. Enabling a tool stays an explicit act:
 * absence is the safe reading, and a group created tomorrow does not silently
 * acquire Finance because someone once enabled it on an ancestor.
 */
function groupToolEnabled(context: AccessContext, groupId: string, toolId: string): boolean {
  for (const ancestor of groupAncestorPath(groupId, context.groups)) {
    const stated = context.groupToolRows.get(`${ancestor}:${toolId}`);
    if (stated !== undefined) return stated;
  }
  return false;
}

/**
 * The one place a permission decision is made.
 *
 * Never trust the client for any of this. The web app hides buttons a user
 * cannot use, but that is a courtesy -- the request behind the button is
 * authorized here, on the server, every time.
 *
 * Returns the account's full resolved permission set for the tool so a caller
 * that needs more than the single action can use it without asking twice: a
 * service can layer an ownership rule ("update your own task, not everyone
 * else's") on top of a granted `canUpdate`. See docs/authorization.md.
 *
 * Throws UnauthorizedError (401) when the identity is the problem,
 * NotFoundError (404) when the target belongs to another team, and
 * ForbiddenError (403) when the permission is.
 */
export async function authorize(
  prisma: PrismaClient,
  request: AuthorizationRequest
): Promise<PermissionSet> {
  const { accountId, tool: toolKey, action, groupId } = request;
  const flag = PERMISSION_FLAG[action];

  const context = await loadContext(prisma, accountId);

  const tool = await prisma.tool.findUnique({
    where: { key: toolKey },
    select: { id: true, isActive: true },
  });

  // A tool switched off system-wide is off for everyone, including a system
  // admin. That is safe rather than a lockout: turning it back on is the TOOLS
  // tool, not this one.
  if (!tool || !tool.isActive) {
    throw new ForbiddenError("Bu modul kullanimda degil");
  }

  // A group from another team is not a permission problem, it is a record the
  // caller has no business knowing exists. 403 would confirm the id; 404 says
  // the same thing to a member of the right team asking about a deleted group.
  if (groupId && !context.groups.some((group) => group.id === groupId)) {
    throw new NotFoundError("Grup bulunamadi");
  }

  const teamWidePermissions = await permissionsFor(
    prisma,
    expandDescendants(context.teamWideRoleIds, context.childrenOfRole),
    tool.id
  );

  // The bypass, and it runs before the group checks on purpose. A team admin is
  // not a member of every department and must not have to be. It also skips the
  // GroupTool gate below, which is the difference between TEAM_WIDE and a
  // director scoped over several departments.
  if (teamWidePermissions[flag]) return teamWidePermissions;

  if (!groupId) {
    throw new ForbiddenError("Bu islem icin takim genelinde yetkiniz yok");
  }

  // Every role that reaches this group: the ones scoped over it or a group
  // above it, plus the in-group roles held by an active member of it.
  const roleIds = context.roleIdsByGroup.get(groupId);
  if (!roleIds || roleIds.size === 0) {
    throw new ForbiddenError("Bu grup icin yetkiniz yok");
  }

  // Why a Yazilim lead cannot open Finance even though they run a department:
  // FINANCE is not enabled for Yazilim, so the request stops before their role
  // is read. A team-wide role has already returned above; this gate is for
  // everyone whose authority comes from a group.
  if (!groupToolEnabled(context, groupId, tool.id)) {
    throw new ForbiddenError("Bu modul bu grup icin kapali");
  }

  const groupPermissions = await permissionsFor(
    prisma,
    expandDescendants(roleIds, context.childrenOfRole),
    tool.id
  );

  // Merged with the team-wide set: a mentor's team-wide read plus a member's
  // in-group write is one permission set, and holding two roles must never
  // subtract from either.
  const effective = mergePermissions([teamWidePermissions, groupPermissions]);

  if (!effective[flag]) {
    throw new ForbiddenError("Bu islem icin yetkiniz yok");
  }

  return effective;
}

/**
 * The permission set without the throw, for endpoints that shape a response
 * rather than gate it -- the calendar filling only the sources an account could
 * have read directly.
 */
export async function canPerform(
  prisma: PrismaClient,
  request: AuthorizationRequest
): Promise<boolean> {
  try {
    await authorize(prisma, request);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this account could ever exercise a grant on this tool.
 *
 * The platform surface (/teams, /tools) is guarded by `requirePlatform`, which
 * reads the account rather than a permission row -- so for an account inside a
 * team a TEAMS grant authorizes nothing, whether it was written by a mistake in
 * a template or straight into the database.
 *
 * This is a *display* rule, and the only place in this file that is not a
 * permission rule: `authorize()` is deliberately left alone, because the route
 * check is what refuses those requests and duplicating it here would put the
 * same decision in two places. What it prevents is /auth/me promising a link
 * the API will answer 403 to -- a grant that cannot be exercised is not
 * harmless, it is a menu of dead ends (docs/authorization.md).
 */
function exercisable(teamId: string | null, toolKey: string): boolean {
  return teamId === null || !isPlatformOnlyTool(toolKey as ToolKey);
}

/**
 * Everything the signed-in account may do, for GET /auth/me.
 *
 * The web app uses this to decide what to render. It is a convenience, not a
 * gate -- every request behind a rendered button still goes through
 * `authorize()`. A client that lies to itself about this map gets a 403.
 *
 * It answers "what can they do" for every tool at once where `authorize`
 * answers "may they do this one" and has to say why not, but both read the same
 * AccessContext and apply the same two rules to it, so there is no second copy
 * of the resolution order to keep in step.
 *
 * `byGroup` covers every group the account has authority over, not only the
 * ones it is a member of. A director scoped above Teknik is a member of nothing
 * and still has to see Mekanik in the sidebar.
 */
export async function resolvePermissionMatrix(
  prisma: PrismaClient,
  accountId: string
): Promise<{
  global: Record<string, PermissionSet>;
  byGroup: Record<string, Record<string, PermissionSet>>;
}> {
  const [context, tools] = await Promise.all([
    loadContext(prisma, accountId),
    prisma.tool.findMany({ where: { isActive: true }, select: { id: true, key: true } }),
  ]);

  const global: Record<string, PermissionSet> = {};
  const byGroup: Record<string, Record<string, PermissionSet>> = {};

  const teamWideRoleIds = expandDescendants(context.teamWideRoleIds, context.childrenOfRole);
  for (const tool of tools) {
    global[tool.key] = exercisable(context.teamId, tool.key)
      ? await permissionsFor(prisma, teamWideRoleIds, tool.id)
      : { ...EMPTY_PERMISSIONS };
  }

  for (const [groupId, held] of context.roleIdsByGroup) {
    const roleIds = expandDescendants(held, context.childrenOfRole);
    const perTool: Record<string, PermissionSet> = {};

    for (const tool of tools) {
      const teamWide = global[tool.key] as PermissionSet;
      // A tool the department does not use contributes nothing, exactly as in
      // authorize: once the tool is off for the group, the only thing that can
      // still grant is the team-wide set, which returned before the gate.
      //
      // Do not shortcut this on "holds a TEAM_WIDE role". That role is also in
      // roleIdsByGroup for every group, so skipping the gate would merge its
      // group-path permissions in and answer yes where authorize answers 403.
      //
      // The platform mask comes first: a group-scoped role could carry the same
      // unexercisable grant, and merging it back in here would undo the mask a
      // few lines up.
      perTool[tool.key] = !exercisable(context.teamId, tool.key)
        ? { ...EMPTY_PERMISSIONS }
        : groupToolEnabled(context, groupId, tool.id)
          ? mergePermissions([teamWide, await permissionsFor(prisma, roleIds, tool.id)])
          : teamWide;
    }

    byGroup[groupId] = perTool;
  }

  return { global, byGroup };
}

/**
 * A role plus everything below it.
 *
 * The edge direction is "parent is above child", and inheritance runs downward:
 * a parent gets the union of the permissions of its descendants. So a team lead
 * ends up with everything a lead has, which has everything a member has -- and
 * adding a permission to the member role reaches all three without a data
 * migration.
 *
 * This is also what makes the hierarchy transitive with nothing stored: an edge
 * 1->2 and an edge 2->3 put 1 above 3 because the walk does not stop at the
 * first hop. It is the reason there is no rank number on Role.
 */
function expandDescendants(
  roleIds: ReadonlySet<string>,
  childrenOf: ReadonlyMap<string, string[]>
): Set<string> {
  const resolved = new Set(roleIds);
  const queue = [...roleIds];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childrenOf.get(current) ?? []) {
      // `resolved` doubles as the cycle guard. roles.service rejects cycles on
      // the write path, but a walk that merely trusts that would hang forever
      // if one ever got in, and this runs on every authorized request.
      if (!resolved.has(child)) {
        resolved.add(child);
        queue.push(child);
      }
    }
  }

  return resolved;
}

async function permissionsFor(
  prisma: PrismaClient,
  roleIds: ReadonlySet<string>,
  toolId: string
): Promise<PermissionSet> {
  if (roleIds.size === 0) return { ...EMPTY_PERMISSIONS };

  const grants = await prisma.rolePermission.findMany({
    where: { roleId: { in: [...roleIds] }, toolId },
    select: { canRead: true, canCreate: true, canUpdate: true, canDelete: true },
  });

  return mergePermissions(grants);
}
