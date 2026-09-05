import type { ToolKey } from "@breakpoint/types";

import { canAnywhere, type PermissionMap } from "./permissions";

export interface NavigationItem {
  href: string;
  label: string;
  tool?: ToolKey;
  /** The route also requires an account outside every team. */
  platformOnly?: boolean;
}

export const NAV_ITEMS: readonly NavigationItem[] = [
  { href: "/", label: "Genel bakis" },
  { href: "/teams", label: "Takimlar", tool: "TEAMS", platformOnly: true },
  { href: "/tasks", label: "Gorevler", tool: "TASKS" },
  { href: "/meetings", label: "Toplantilar", tool: "MEETINGS" },
  { href: "/calendar", label: "Takvim", tool: "CALENDAR" },
  { href: "/gantt", label: "Zaman cizelgesi", tool: "GANTT" },
  { href: "/finance", label: "Finans", tool: "FINANCE" },
  { href: "/sponsors", label: "Sponsorlar", tool: "SPONSORS" },
  { href: "/accounts", label: "Hesaplar", tool: "ACCOUNTS" },
  { href: "/groups", label: "Gruplar", tool: "GROUPS" },
  { href: "/roles", label: "Roller", tool: "ROLES" },
  { href: "/tools", label: "Moduller", tool: "TOOLS", platformOnly: true },
  { href: "/seasons", label: "Sezonlar", tool: "SEASONS" },
];

/**
 * Do not advertise a platform route to an account that requirePlatform will
 * always refuse. TOOLS alone cannot decide this: team admins legitimately hold
 * it for the team-local PUT /groups/:id/tools operation.
 */
export function visibleNavigationItems(
  teamId: string | null | undefined,
  permissions: PermissionMap | null | undefined
): readonly NavigationItem[] {
  return NAV_ITEMS.filter(
    (item) =>
      (!item.platformOnly || teamId === null) &&
      (!item.tool || canAnywhere(permissions, item.tool, "read"))
  );
}
