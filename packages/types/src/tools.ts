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
