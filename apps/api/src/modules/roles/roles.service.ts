import type { Prisma, PrismaClient } from "@breakpoint/db";
import {
  isPlatformOnlyTool,
  placementForbidsGroupScope,
  placementNeedsGroupScope,
  roleDepths,
  type RolePermissionMatrixInput,
  type RolePlacement,
} from "@breakpoint/types";

import { ConflictError, NotFoundError } from "../../lib/http-errors";
import { paginated, toPrismaPage } from "../../lib/pagination";
import type { CreateRoleInput, ListRolesQuery, UpdateRoleInput } from "./roles.schema";

const roleSelect = {
  id: true,
  teamId: true,
  key: true,
  name: true,
  description: true,
  placement: true,
  isSystemRole: true,
  groupScopes: { select: { group: { select: { id: true, name: true } } } },
  permissions: {
    select: {
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canDelete: true,
      tool: { select: { id: true, key: true, name: true } },
    },
  },
  children: { select: { childRole: { select: { id: true, key: true, name: true } } } },
  parents: { select: { parentRole: { select: { id: true, key: true, name: true } } } },
  _count: { select: { accountRoles: { where: { isActive: true } } } },
} satisfies Prisma.RoleSelect;

type RoleRow = Prisma.RoleGetPayload<{ select: typeof roleSelect }>;

function serialize(role: RoleRow, depth: number) {
  const { permissions, children, parents, groupScopes, _count, ...rest } = role;
  return {
    ...rest,
    // Derived from the RoleHierarchy edges on every read, never stored. The old
    // hierarchyLevel column was the same number maintained by hand beside the
    // graph, and the two could disagree.
    depth,
    assignedCount: _count.accountRoles,
    groupScopeIds: groupScopes.map((scope) => scope.group.id),
    groupScopes: groupScopes.map((scope) => scope.group),
    permissions: permissions.map((entry) => ({
      toolId: entry.tool.id,
      tool: entry.tool.key,
      toolName: entry.tool.name,
      canRead: entry.canRead,
      canCreate: entry.canCreate,
      canUpdate: entry.canUpdate,
      canDelete: entry.canDelete,
    })),
    // "children" are the roles this one is above, and therefore the ones whose
    // permissions it inherits.
    children: children.map((edge) => edge.childRole),
    parents: parents.map((edge) => edge.parentRole),
  };
}

export function createRolesService(prisma: PrismaClient) {
  /**
   * Roles a team may see: its own, plus the platform roles that sit above every
   * team.
   *
   * Platform roles are visible because a team admin has to be able to tell that
   * SYSTEM_ADMIN exists and that they are not it. They are not editable -- every
   * write below filters on the team id alone.
   */
  const readableBy = (teamId: string): Prisma.RoleWhereInput => ({
    OR: [{ teamId }, { teamId: null }],
  });

  /** Edges among a set of roles, for computing display depth. */
  const edgesAmong = async (roleIds: readonly string[]) =>
    prisma.roleHierarchy.findMany({
      where: { parentRoleId: { in: [...roleIds] }, childRoleId: { in: [...roleIds] } },
      select: { parentRoleId: true, childRoleId: true },
    });

  const serializeMany = async (rows: RoleRow[]) => {
    const depths = roleDepths(
      rows.map((role) => role.id),
      await edgesAmong(rows.map((role) => role.id))
    );
    return rows.map((role) => serialize(role, depths.get(role.id) ?? 0));
  };

  /**
   * Every role reachable downward from `roleId`, itself included.
   *
   * Used for cycle detection. The edge table is small enough to load whole,
   * and the walk needs arbitrary depth, so this beats a recursive CTE.
   */
  const descendantsOf = async (roleId: string): Promise<Set<string>> => {
    const edges = await prisma.roleHierarchy.findMany({
      select: { parentRoleId: true, childRoleId: true },
    });

    const childrenOf = new Map<string, string[]>();
    for (const edge of edges) {
      const children = childrenOf.get(edge.parentRoleId);
      if (children) children.push(edge.childRoleId);
      else childrenOf.set(edge.parentRoleId, [edge.childRoleId]);
    }

    const seen = new Set([roleId]);
    const queue = [roleId];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const child of childrenOf.get(current) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    return seen;
  };

  /**
   * The half of the placement rule that needs the database: the named groups
   * have to exist and belong to this team.
   *
   * Without it a team admin could scope one of their roles over another team's
   * department by pasting its id, and the subtree expansion in authorize()
   * would honour it.
   */
  const assertGroupScope = async (
    teamId: string,
    placement: RolePlacement,
    groupScopeIds: readonly string[]
  ) => {
    if (placementForbidsGroupScope(placement) && groupScopeIds.length > 0) {
      throw new ConflictError("Bu konum tum takimi kapsar, ayrica grup secilemez");
    }
    if (placementNeedsGroupScope(placement) && groupScopeIds.length === 0) {
      throw new ConflictError("Bu konum icin en az bir grup secilmeli");
    }
    if (groupScopeIds.length === 0) return;

    const found = await prisma.group.count({
      where: { id: { in: [...groupScopeIds] }, teamId },
    });
    if (found !== new Set(groupScopeIds).size) {
      throw new NotFoundError("Grup bulunamadi");
    }
  };

  return {
    list: async (teamId: string, query: ListRolesQuery) => {
      const where: Prisma.RoleWhereInput = {
        ...readableBy(teamId),
        ...(query.placement ? { placement: query.placement } : {}),
      };

      const [rows, total] = await prisma.$transaction([
        prisma.role.findMany({
          where,
          select: roleSelect,
          orderBy: { name: "asc" },
          ...toPrismaPage(query),
        }),
        prisma.role.count({ where }),
      ]);

      // Sorted by depth on the way out rather than in SQL: the order comes from
      // the hierarchy graph, and Postgres has no column to sort it by any more.
      const serialized = await serializeMany(rows);
      serialized.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
      return paginated(serialized, total, query);
    },

    getById: async (teamId: string, id: string) => {
      const role = await prisma.role.findFirst({
        where: { id, ...readableBy(teamId) },
        select: roleSelect,
      });
      if (!role) return null;
      return (await serializeMany([role]))[0];
    },

    create: async (teamId: string, input: CreateRoleInput) => {
      const { groupScopeIds, ...fields } = input;
      await assertGroupScope(teamId, fields.placement, groupScopeIds);

      const role = await prisma.role.create({
        data: {
          ...fields,
          teamId,
          groupScopes: { create: groupScopeIds.map((groupId) => ({ groupId })) },
        },
        select: roleSelect,
      });
      return (await serializeMany([role]))[0];
    },

    /**
     * Updates the role and, when the placement changes, the assignments that
     * placement invalidates.
     *
     * An IN_GROUP role turned TEAM_WIDE leaves AccountRole rows carrying a
     * groupId the model forbids, and the reverse leaves rows with none where one
     * is required. Rewriting them here keeps the invariant true at every moment
     * rather than eventually -- the alternative is refusing the change, which
     * just moves the work to a human.
     */
    update: async (teamId: string, id: string, input: UpdateRoleInput) => {
      const existing = await prisma.role.findFirst({
        where: { id, teamId },
        select: {
          id: true,
          placement: true,
          groupScopes: { select: { groupId: true } },
        },
      });
      if (!existing) throw new NotFoundError("Rol bulunamadi");

      const { groupScopeIds, ...fields } = input;
      const placement = (fields.placement ?? existing.placement) as RolePlacement;
      const storedScopeIds = existing.groupScopes.map((scope) => scope.groupId);
      const placementChanged =
        fields.placement !== undefined && fields.placement !== existing.placement;

      // Omitted scopes mean "keep what is stored" for every placement that can
      // use them. A move to a placement that forbids scopes is the exception:
      // it clears them automatically, while an explicitly non-empty list still
      // reports the conflict instead of silently discarding caller input.
      const effectiveScopeIds = placementForbidsGroupScope(placement)
        ? groupScopeIds ?? []
        : groupScopeIds ?? storedScopeIds;
      const scopeIdsToWrite = placementForbidsGroupScope(placement)
        ? groupScopeIds !== undefined || placementChanged
          ? []
          : undefined
        : groupScopeIds;

      if (groupScopeIds !== undefined || placementChanged) {
        await assertGroupScope(teamId, placement, effectiveScopeIds);
      }

      await prisma.$transaction(async (tx) => {
        await tx.role.update({ where: { id }, data: fields });

        if (scopeIdsToWrite !== undefined) {
          await tx.roleGroupScope.deleteMany({ where: { roleId: id } });
          if (scopeIdsToWrite.length > 0) {
            await tx.roleGroupScope.createMany({
              data: scopeIdsToWrite.map((groupId) => ({ roleId: id, groupId })),
            });
          }
        }

        if (fields.placement !== undefined && fields.placement !== existing.placement) {
          // IN_GROUP is the only placement scoped by the assignment. Moving to
          // it cannot invent a group, so those assignments are deactivated and
          // have to be made again deliberately; moving away from it just drops
          // a groupId that no longer means anything.
          if (fields.placement === "IN_GROUP") {
            await tx.accountRole.updateMany({
              where: { roleId: id, groupId: null },
              data: { isActive: false },
            });
          } else {
            await tx.accountRole.updateMany({ where: { roleId: id }, data: { groupId: null } });
          }
        }
      });

      const role = await prisma.role.findUniqueOrThrow({ where: { id }, select: roleSelect });
      return (await serializeMany([role]))[0];
    },

    /**
     * Hard delete, but only for a role nothing depends on.
     *
     * System roles are refused outright: TEAM_ADMIN is matched by key in the
     * migrations, and deleting it would leave a team with no way to administer
     * itself. Roles that are still assigned are refused too, with a message that
     * says how many -- the foreign key would stop it anyway, but as a P2003 that
     * reads "Referenced record does not exist", which is not what happened.
     */
    remove: async (teamId: string, id: string) => {
      const role = await prisma.role.findFirst({
        where: { id, teamId },
        select: {
          isSystemRole: true,
          name: true,
          _count: { select: { accountRoles: true } },
        },
      });

      if (!role) throw new NotFoundError("Rol bulunamadi");
      if (role.isSystemRole) throw new ConflictError("Sistem rolleri silinemez");
      if (role._count.accountRoles > 0) {
        throw new ConflictError(
          `${role.name} rolu ${role._count.accountRoles} hesaba atanmis durumda, once atamalari kaldirin`
        );
      }

      await prisma.role.delete({ where: { id } });
    },

    /**
     * Adds a "parent is above child" edge.
     *
     * This is the whole of the hierarchy. There is no rank number to keep in
     * step, and the relation is transitive for free: an edge 1->2 plus an edge
     * 2->3 already puts 1 above 3, because permission resolution walks to
     * arbitrary depth rather than stopping at the first hop.
     *
     * Three things make a graph like this go wrong and none can be a database
     * constraint here: an edge from a role to itself, a cycle, and an edge
     * across two teams. Prisma can express neither a CHECK nor a recursive
     * assertion, and hand-adding one to a migration desynchronises
     * schema.prisma permanently (docs/migrations.md).
     *
     * A cycle would be worse than wrong data: permission resolution walks these
     * edges on every authorized request, so a loop is a hung request, not a bad
     * answer.
     */
    linkRoles: async (teamId: string, parentRoleId: string, childRoleId: string) => {
      if (parentRoleId === childRoleId) {
        throw new ConflictError("Bir rol kendisine bagli olamaz");
      }

      // Both must be this team's own roles. Platform roles are readable but not
      // wireable: hanging SYSTEM_ADMIN off a team's tree would let that team
      // grant itself the platform admin's permissions by inheritance.
      const roles = await prisma.role.findMany({
        where: { id: { in: [parentRoleId, childRoleId] }, teamId },
        select: { id: true },
      });
      if (roles.length !== 2) throw new NotFoundError("Rol bulunamadi");

      // Adding parent -> child closes a loop exactly when parent is already
      // somewhere below child.
      const belowChild = await descendantsOf(childRoleId);
      if (belowChild.has(parentRoleId)) {
        throw new ConflictError("Bu baglanti rol hiyerarsisinde dongu olusturur");
      }

      await prisma.roleHierarchy.create({ data: { parentRoleId, childRoleId } });
    },

    unlinkRoles: async (teamId: string, parentRoleId: string, childRoleId: string) => {
      const roles = await prisma.role.count({
        where: { id: { in: [parentRoleId, childRoleId] }, teamId },
      });
      if (roles !== 2) throw new NotFoundError("Rol bulunamadi");

      await prisma.roleHierarchy.delete({
        where: { parentRoleId_childRoleId: { parentRoleId, childRoleId } },
      });
    },

    /**
     * The hierarchy as the UI has to draw it: the direct edges, plus the
     * transitive closure.
     *
     * The closure is what answers "1 is bound to 2, 2 is bound to 3, so 1 is
     * bound to 3 as well" on screen. It is computed, not stored -- storing it
     * would mean recomputing it on every edge change, and the walk is cheap.
     */
    graph: async (teamId: string) => {
      const roles = await prisma.role.findMany({
        where: { teamId },
        select: { id: true, key: true, name: true, placement: true },
        orderBy: { name: "asc" },
      });
      const ids = new Set(roles.map((role) => role.id));
      const edges = (
        await prisma.roleHierarchy.findMany({
          select: { parentRoleId: true, childRoleId: true },
        })
      ).filter((edge) => ids.has(edge.parentRoleId) && ids.has(edge.childRoleId));

      const childrenOf = new Map<string, string[]>();
      for (const edge of edges) {
        const children = childrenOf.get(edge.parentRoleId);
        if (children) children.push(edge.childRoleId);
        else childrenOf.set(edge.parentRoleId, [edge.childRoleId]);
      }

      const depths = roleDepths(
        roles.map((role) => role.id),
        edges
      );

      return {
        roles: roles
          .map((role) => ({ ...role, depth: depths.get(role.id) ?? 0 }))
          .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)),
        edges,
        closure: roles.map((role) => {
          // Everything below this role, at any depth. The seen set is also the
          // cycle guard: the write path rejects loops, this declines to hang if
          // one gets in.
          const below = new Set<string>();
          const queue = [...(childrenOf.get(role.id) ?? [])];
          while (queue.length > 0) {
            const current = queue.shift() as string;
            if (below.has(current)) continue;
            below.add(current);
            queue.push(...(childrenOf.get(current) ?? []));
          }
          return { roleId: role.id, below: [...below] };
        }),
      };
    },

    /**
     * Replaces the role's whole permission matrix.
     *
     * Whole-set, like every other assignment in this system: a tool left out of
     * the list is denied. Sending one flag at a time would let a client build a
     * half-applied grant, and the matrix is small enough that there is no
     * reason to.
     */
    replacePermissions: async (
      teamId: string,
      roleId: string,
      input: RolePermissionMatrixInput
    ) => {
      const role = await prisma.role.findFirst({
        where: { id: roleId, teamId },
        select: { id: true },
      });
      if (!role) throw new NotFoundError("Rol bulunamadi");

      // Every role this can reach is a team role -- the lookup above filters on
      // teamId, and a platform role has none -- so a platform-only tool here is
      // always an escalation. It is the *flag* that is refused, never the entry:
      // the editor sends the whole matrix on every save, so an ordinary role
      // edit carries a TEAMS row with four falses, and refusing the row itself
      // would break every save in the app. An empty grant grants nothing.
      //
      // The guarantee is requirePlatform on the routes, not this. This is what
      // keeps the row from being written in the first place, so nobody has to
      // read a permission table full of grants that authorize nothing.
      const escalating = input.permissions.find(
        (entry) =>
          isPlatformOnlyTool(entry.tool) &&
          (entry.canRead || entry.canCreate || entry.canUpdate || entry.canDelete)
      );
      if (escalating) {
        throw new ConflictError(
          `${escalating.tool} yetkisi yalnizca platform rolune verilebilir`
        );
      }

      const tools = await prisma.tool.findMany({
        where: { key: { in: input.permissions.map((entry) => entry.tool) } },
        select: { id: true, key: true },
      });
      const idByKey = new Map(tools.map((tool) => [tool.key, tool.id]));

      await prisma.$transaction([
        prisma.rolePermission.deleteMany({ where: { roleId } }),
        prisma.rolePermission.createMany({
          data: input.permissions.map((entry) => ({
            roleId,
            toolId: idByKey.get(entry.tool) as string,
            canRead: entry.canRead,
            canCreate: entry.canCreate,
            canUpdate: entry.canUpdate,
            canDelete: entry.canDelete,
          })),
        }),
      ]);
    },
  };
}
