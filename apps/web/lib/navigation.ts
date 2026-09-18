import type { ToolKey } from "@breakpoint/types";

import { can, canAnywhere, type PermissionMap } from "./permissions";

export interface NavigationItem {
  href: string;
  label: string;
  tool?: ToolKey;
  /** The route also requires an account outside every team. */
  platformOnly?: boolean;
  /** The endpoint has no group context, so a group-scoped grant cannot open it. */
  globalOnly?: boolean;
}

export interface NavigationSection {
  /** null for the top, unlabelled section (Ana Sayfa, Takvim). */
  label: string | null;
  items: readonly NavigationItem[];
}

/**
 * Grouped for a team account's sidebar. A section with nothing the account
 * can open never renders its heading -- see visibleNavigationSections --
 * so "Kaynaklar" simply does not exist for someone with neither FINANCE nor
 * SPONSORS, rather than showing as an empty label above nothing.
 */
export const NAV_SECTIONS: readonly NavigationSection[] = [
  {
    label: null,
    items: [
      { href: "/", label: "Ana Sayfa" },
      { href: "/calendar", label: "Takvim", tool: "CALENDAR" },
    ],
  },
  {
    label: "Çalışmalar",
    items: [
      { href: "/tasks", label: "Görevler", tool: "TASKS" },
      { href: "/meetings", label: "Toplantılar", tool: "MEETINGS" },
      { href: "/gantt", label: "Zaman Çizelgesi", tool: "GANTT" },
    ],
  },
  {
    label: "Takım",
    items: [
      { href: "/accounts", label: "Üyeler", tool: "ACCOUNTS" },
      { href: "/groups", label: "Gruplar", tool: "GROUPS" },
    ],
  },
  {
    label: "Kaynaklar",
    items: [
      { href: "/sponsors", label: "Sponsorlar", tool: "SPONSORS" },
      { href: "/finance", label: "Finans", tool: "FINANCE" },
    ],
  },
  {
    label: "Yönetim",
    items: [
      { href: "/roles", label: "Roller ve Yetkiler", tool: "ROLES" },
      { href: "/seasons", label: "Sezonlar", tool: "SEASONS" },
      // #23 grants audit access independently of role editing; keep its own route.
      { href: "/audit-log", label: "Denetim Kayıtları", tool: "AUDIT_LOG", globalOnly: true },
    ],
  },
];

/** A platform system admin belongs to no team, so its sidebar is this short list instead. */
export const PLATFORM_NAV_SECTIONS: readonly NavigationSection[] = [
  {
    label: null,
    items: [
      { href: "/", label: "Platform" },
      { href: "/teams", label: "Takımlar", tool: "TEAMS", platformOnly: true },
      { href: "/tools", label: "Platform Modülleri", tool: "TOOLS", platformOnly: true },
    ],
  },
];

function isVisible(
  item: NavigationItem,
  teamId: string | null | undefined,
  permissions: PermissionMap | null | undefined
): boolean {
  return (
    (!item.platformOnly || teamId === null) &&
    (!item.tool ||
      (item.globalOnly ? can(permissions, item.tool, "read") : canAnywhere(permissions, item.tool, "read")))
  );
}

/**
 * Hides a link the account cannot follow, and drops a section heading
 * entirely once nothing under it is visible -- the sidebar the roadmap asks
 * for shows no title above an empty list. This is a courtesy, not a
 * control: every route behind it is authorized again on the server.
 */
export function visibleNavigationSections(
  teamId: string | null | undefined,
  permissions: PermissionMap | null | undefined
): readonly NavigationSection[] {
  const sections = teamId === null ? PLATFORM_NAV_SECTIONS : NAV_SECTIONS;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => isVisible(item, teamId, permissions)),
    }))
    .filter((section) => section.items.length > 0);
}
