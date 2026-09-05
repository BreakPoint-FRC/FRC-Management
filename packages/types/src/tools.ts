import { z } from "zod";

// The modules permissions are granted against. Administrative actions are tools
// too -- that is what lets "admin" be a role with permissions rather than a
// separate entity with a hard-coded bypass.
//
// A closed enum rather than a free string, so `authorize(..., { tool: "TSAKS" })`
// is a typecheck failure instead of a silent 403 in March. Adding a tool means
// adding it here, adding a row (a migration), and giving some role permission
// on it.
export const TOOL_KEYS = [
  // Feature modules
  "TASKS",
  "TODO",
  "TASK_LOGS",
  "GANTT",
  "MEETINGS",
  "CALENDAR",
  "FINANCE",
  "SPONSORS",
  // Administrative modules
  "ACCOUNTS",
  "GROUPS",
  "ROLES",
  "TOOLS",
  "PERMISSIONS",
  "SEASONS",
  "TEAMS",
] as const;

export const toolKeySchema = z.enum(TOOL_KEYS);

/**
 * Tools no team role may be granted.
 *
 * `TEAMS` opens, lists and archives every team on the platform. Granting it to
 * a team's own role is a privilege escalation rather than a generous
 * permission, and nothing a team does inside itself needs it.
 *
 * `TOOLS` is deliberately *not* here even though `/tools` is platform-only too.
 * The permission and the routes are different questions: a team admin holds
 * `TOOLS` to switch modules on and off per department
 * (`groups.routes` PUT /groups/:id/tools, and the wizard step behind it), while
 * editing the global module list is guarded on the route by `requirePlatform`.
 *
 * This list is what the write path (`roles.service.replacePermissions`) refuses
 * and what the permission matrix draws as locked. It is *not* the guarantee --
 * that is `requirePlatform`, which reads the account rather than a permission
 * row, so a grant written straight to the database still authorizes nothing.
 */
export const PLATFORM_ONLY_TOOL_KEYS = ["TEAMS"] as const;

export function isPlatformOnlyTool(key: ToolKey): boolean {
  return (PLATFORM_ONLY_TOOL_KEYS as readonly ToolKey[]).includes(key);
}

export const toolSchema = z.object({
  id: z.string(),
  key: toolKeySchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  isActive: z.boolean(),
});

// Which modules a department uses. A group with no row for a tool does not have
// it -- see the authorization order in docs/authorization.md.
export const groupToolSchema = z.object({
  toolId: z.string(),
  isEnabled: z.boolean(),
});

export type Tool = z.infer<typeof toolSchema>;
export type ToolKey = z.infer<typeof toolKeySchema>;
export type GroupTool = z.infer<typeof groupToolSchema>;
