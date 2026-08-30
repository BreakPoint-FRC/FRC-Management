import type { PrismaClient } from "@breakpoint/db";
import {
  EMPTY_PERMISSIONS,
  PERMISSION_FLAG,
  mergePermissions,
  type PermissionAction,
  type PermissionSet,
  type ToolKey,
} from "@breakpoint/types";

import { ForbiddenError, UnauthorizedError } from "./http-errors";

export interface AuthorizationRequest {
  accountId: string;
  tool: ToolKey;
  action: PermissionAction;
  /**
   * The department the request is about.
   *
   * Omitted or null means the request is not scoped to one -- an administrative
   * action, or a cross-group record such as a task with no group. Only a GLOBAL
   * role can authorize those, because there is no membership or GroupTool row
   * to consult.
   */
  groupId?: string | null;
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
 * Throws UnauthorizedError (401) when the identity is the problem and
 * ForbiddenError (403) when the permission is.
 */
export async function authorize(
  prisma: PrismaClient,
  request: AuthorizationRequest
): Promise<PermissionSet> {
  const { accountId, tool: toolKey, action, groupId } = request;
  const flag = PERMISSION_FLAG[action];

  // --- 1. Is the account real, active, and still on the team? ---------------
  // Cheapest check, and the only one that is a 401: re-authenticating cannot
  // fix any of the later failures.
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      isActive: true,
      archivedAt: true,
      roles: {
        where: { isActive: true },
        select: { groupId: true, role: { select: { id: true, scope: true } } },
      },
    },
  });

  if (!account || !account.isActive || account.archivedAt !== null) {
    throw new UnauthorizedError("Hesap aktif degil");
  }

  const tool = await prisma.tool.findUnique({
    where: { key: toolKey },
    select: { id: true, isActive: true },
  });

  // A tool switched off system-wide is off for everyone, including
  // SYSTEM_ADMIN. That is safe rather than a lockout: turning it back on is the
  // TOOLS tool, not this one.
  if (!tool || !tool.isActive) {
    throw new ForbiddenError("Bu modul kullanimda degil");
  }

  // Loaded once and walked in memory for both the global and the group pass.
  // The table holds one row per "is above" relationship -- dozens at most --
  // and the walk needs arbitrary depth, so this beats a recursive CTE or a
  // query per level on every authorized request.
  const childrenOf = await loadHierarchy(prisma);

  // --- 2. Does a GLOBAL role already allow it? ------------------------------
  // Before the group checks on purpose. A SYSTEM_ADMIN is not a member of every
  // department and must not have to be; neither is a mentor who reads
  // everything. This is the bypass the spec asks for, and it is deliberately
  // the only one.
  const globalRoleIds = new Set(
    account.roles
      .filter((entry) => entry.role.scope === "GLOBAL")
      .map((entry) => entry.role.id)
  );

  const globalPermissions = await permissionsFor(
    prisma,
    expandDescendants(globalRoleIds, childrenOf),
    tool.id
  );

  if (globalPermissions[flag]) return globalPermissions;

  // --- 3. With no group, there is nothing further to consult ----------------
  if (!groupId) {
    throw new ForbiddenError("Bu islem icin takim genelinde yetkiniz yok");
  }

  // --- 4. Is the account actually in that department? -----------------------
  const membership = await prisma.groupMembership.findUnique({
    where: { accountId_groupId: { accountId, groupId } },
    select: { isActive: true },
  });

  if (!membership || !membership.isActive) {
    throw new ForbiddenError("Bu grubun uyesi degilsiniz");
  }

  // --- 5. Does the department use this tool at all? -------------------------
  // A missing row means no. Enabling a tool for a group is an explicit act, so
  // absence is the safe reading -- a group created tomorrow does not silently
  // acquire Finance.
  const groupTool = await prisma.groupTool.findUnique({
    where: { groupId_toolId: { groupId, toolId: tool.id } },
    select: { isEnabled: true },
  });

  if (!groupTool || !groupTool.isEnabled) {
    throw new ForbiddenError("Bu modul bu grup icin kapali");
  }

  // --- 6. Do the roles held *in that group* allow it? -----------------------
  // Only roles assigned in this group count. Being Programming Lead says
  // nothing about what you may do in Business, which is the whole reason
  // AccountRole carries a groupId.
  const groupRoleIds = new Set(
    account.roles
      .filter((entry) => entry.role.scope === "GROUP" && entry.groupId === groupId)
      .map((entry) => entry.role.id)
  );

  const groupPermissions = await permissionsFor(
    prisma,
    expandDescendants(groupRoleIds, childrenOf),
    tool.id
  );

  // Merged with the global set: a mentor's team-wide read plus a member's
  // in-group write is one permission set, and holding two roles must never
  // subtract from either.
  const effective = mergePermissions([globalPermissions, groupPermissions]);

  // --- 7. Decide -----------------------------------------------------------
  if (!effective[flag]) {
    throw new ForbiddenError("Bu islem icin yetkiniz yok");
  }

  return effective;
}

/**
 * The permission set without the throw, for endpoints that shape a response
 * rather than gate it -- GET /auth/me listing what the UI may show.
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
 * Everything the signed-in account may do, for GET /auth/me.
 *
 * The web app uses this to decide what to render. It is a convenience, not a
 * gate -- every request behind a rendered button still goes through
 * `authorize()`. A client that lies to itself about this map gets a 403.
 *
 * Applies the same rules as steps 2, 4, 5 and 6 above and shares their helpers;
 * it exists separately because it answers "what can they do" for every tool at
 * once, where `authorize` answers "may they do this one" and has to say why
 * not. **Change one and check the other.**
 */
export async function resolvePermissionMatrix(
  prisma: PrismaClient,
  accountId: string
): Promise<{
  global: Record<string, PermissionSet>;
  byGroup: Record<string, Record<string, PermissionSet>>;
}> {
  const [account, tools, childrenOf, memberships, groupTools] = await Promise.all([
    prisma.account.findUnique({
      where: { id: accountId },
      select: {
        roles: {
          where: { isActive: true },
          select: { groupId: true, role: { select: { id: true, scope: true } } },
        },
      },
    }),
    prisma.tool.findMany({ where: { isActive: true }, select: { id: true, key: true } }),
    loadHierarchy(prisma),
    prisma.groupMembership.findMany({
      where: { accountId, isActive: true },
      select: { groupId: true },
    }),
    prisma.groupTool.findMany({
      where: { isEnabled: true },
      select: { groupId: true, toolId: true },
    }),
  ]);

  const global: Record<string, PermissionSet> = {};
  const byGroup: Record<string, Record<string, PermissionSet>> = {};
  if (!account) return { global, byGroup };

  const globalRoleIds = expandDescendants(
    new Set(
      account.roles
        .filter((entry) => entry.role.scope === "GLOBAL")
        .map((entry) => entry.role.id)
    ),
    childrenOf
  );

  for (const tool of tools) {
    global[tool.key] = await permissionsFor(prisma, globalRoleIds, tool.id);
  }

  const enabled = new Set(groupTools.map((row) => `${row.groupId}:${row.toolId}`));

  for (const { groupId } of memberships) {
    const groupRoleIds = expandDescendants(
      new Set(
        account.roles
          .filter((entry) => entry.role.scope === "GROUP" && entry.groupId === groupId)
          .map((entry) => entry.role.id)
      ),
      childrenOf
    );

    const perTool: Record<string, PermissionSet> = {};
    for (const tool of tools) {
      // A tool the department does not use contributes nothing, exactly as in
      // step 5. The global set still stands on its own -- that is the bypass.
      perTool[tool.key] = enabled.has(`${groupId}:${tool.id}`)
        ? mergePermissions([
            global[tool.key] as PermissionSet,
            await permissionsFor(prisma, groupRoleIds, tool.id),
          ])
        : (global[tool.key] as PermissionSet);
    }
    byGroup[groupId] = perTool;
  }

  return { global, byGroup };
}

/** parentRoleId -> childRoleIds. */
async function loadHierarchy(prisma: PrismaClient): Promise<Map<string, string[]>> {
  const edges = await prisma.roleHierarchy.findMany({
    select: { parentRoleId: true, childRoleId: true },
  });

  const childrenOf = new Map<string, string[]>();
  for (const edge of edges) {
    const children = childrenOf.get(edge.parentRoleId);
    if (children) children.push(edge.childRoleId);
    else childrenOf.set(edge.parentRoleId, [edge.childRoleId]);
  }
  return childrenOf;
}

/**
 * A role plus everything below it.
 *
 * The edge direction is "parent is above child", and inheritance runs downward:
 * a parent gets the union of its descendants' permissions. So Team Lead ends up
 * with everything Lead has, which has everything Member has -- and adding a
 * permission to Member reaches all three without a data migration.
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
