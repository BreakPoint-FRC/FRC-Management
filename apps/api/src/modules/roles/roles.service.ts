import type { Prisma, PrismaClient } from "@breakpoint/db";
import type { RolePermissionMatrixInput } from "@breakpoint/types";

import { ConflictError, NotFoundError } from "../../lib/http-errors";
import { paginated, toPrismaPage } from "../../lib/pagination";
import type { CreateRoleInput, ListRolesQuery, UpdateRoleInput } from "./roles.schema";

const roleSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  scope: true,
  hierarchyLevel: true,
  isSystemRole: true,
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

function serialize(role: RoleRow) {
  const { permissions, children, parents, _count, ...rest } = role;
  return {
    ...rest,
    assignedCount: _count.accountRoles,
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

  return {
    list: async (query: ListRolesQuery) => {
      const where: Prisma.RoleWhereInput = query.scope ? { scope: query.scope } : {};

      const [rows, total] = await prisma.$transaction([
        prisma.role.findMany({
          where,
          select: roleSelect,
          orderBy: [{ hierarchyLevel: "asc" }, { name: "asc" }],
          ...toPrismaPage(query),
        }),
        prisma.role.count({ where }),
      ]);

      return paginated(rows.map(serialize), total, query);
    },

    getById: async (id: string) => {
      const role = await prisma.role.findUnique({ where: { id }, select: roleSelect });
      return role && serialize(role);
    },

    create: async (input: CreateRoleInput) => {
      const role = await prisma.role.create({ data: input, select: roleSelect });
      return serialize(role);
    },

    update: async (id: string, input: UpdateRoleInput) => {
      const role = await prisma.role.update({ where: { id }, data: input, select: roleSelect });
      return serialize(role);
    },

    /**
     * Hard delete, but only for a role nothing depends on.
     *
     * System roles are refused outright: SYSTEM_ADMIN is matched by key in the
     * seed and the migrations, and deleting it would leave an instance with no
     * way to administer itself. Roles that are still assigned are refused too,
     * with a message that says who -- the foreign key would stop it anyway, but
     * as a P2003 that reads "Referenced record does not exist", which is not
     * what happened.
     */
    remove: async (id: string) => {
      const role = await prisma.role.findUnique({
        where: { id },
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
     * Two things make a graph like this go wrong, and neither can be a database
     * constraint here: an edge from a role to itself, and a cycle. Prisma can
     * express neither a CHECK nor a recursive assertion, and hand-adding one to
     * a migration desynchronises schema.prisma permanently (docs/migrations.md).
     *
     * A cycle would be worse than wrong data: permission resolution walks these
     * edges on every authorized request, so a loop is a hung request, not a bad
     * answer.
     */
    linkRoles: async (parentRoleId: string, childRoleId: string) => {
      if (parentRoleId === childRoleId) {
        throw new ConflictError("Bir rol kendisine bagli olamaz");
      }

      const roles = await prisma.role.findMany({
        where: { id: { in: [parentRoleId, childRoleId] } },
        select: { id: true, name: true },
      });
      if (roles.length !== 2) throw new NotFoundError("Rol bulunamadi");

      // Adding parent -> child closes a loop exactly when parent is already
      // somewhere below child.
      const belowChild = await descendantsOf(childRoleId);
      if (belowChild.has(parentRoleId)) {
        throw new ConflictError(
          "Bu baglanti rol hiyerarsisinde dongu olusturur"
        );
      }

      await prisma.roleHierarchy.create({ data: { parentRoleId, childRoleId } });
    },

    unlinkRoles: async (parentRoleId: string, childRoleId: string) => {
      await prisma.roleHierarchy.delete({
        where: { parentRoleId_childRoleId: { parentRoleId, childRoleId } },
      });
    },

    /**
     * Replaces the role's whole permission matrix.
     *
     * Whole-set, like every other assignment in this system: a tool left out of
     * the list is denied. Sending one flag at a time would let a client build a
     * half-applied grant, and the matrix is small enough that there is no
     * reason to.
     */
    replacePermissions: async (roleId: string, input: RolePermissionMatrixInput) => {
      await prisma.role.findUniqueOrThrow({ where: { id: roleId }, select: { id: true } });

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
