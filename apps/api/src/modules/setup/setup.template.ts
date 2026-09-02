import type { RolePlacement } from "@breakpoint/types";

/**
 * A starting set of roles, offered at the ROLES step.
 *
 * Building a role tree and a permission matrix from nothing is a lot to ask of
 * someone on their first day with the system, and most FRC teams are shaped
 * roughly like this. It is a starting point and not a constraint: every row can
 * be renamed, rewired or deleted afterwards, which is the whole reason roles
 * are rows rather than an enum.
 *
 * This is the same structure the pre-tenancy migration seeded, minus the
 * numbers. Depth comes from `above` now.
 */
export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  placement: RolePlacement;
  /** Keys this role sits above, and therefore inherits the permissions of. */
  above: string[];
  /** tool key -> the four flags, as "rcud" letters. Absent means no grant. */
  grants: Record<string, string>;
}

export const FRC_ROLE_TEMPLATE: RoleTemplate[] = [
  {
    key: "PRESIDENT",
    name: "Baskan",
    description: "Takimin tamamindan sorumlu.",
    placement: "TEAM_WIDE",
    above: ["TEAM_LEAD"],
    grants: { FINANCE: "rcud", SPONSORS: "rcud", ACCOUNTS: "rcu", GROUPS: "rcu", SEASONS: "rcu" },
  },
  {
    key: "VICE_PRESIDENT",
    name: "Baskan Yardimcisi",
    description: "Baskana vekalet eder.",
    placement: "TEAM_WIDE",
    above: ["TEAM_LEAD"],
    grants: { SPONSORS: "rcu", FINANCE: "r" },
  },
  {
    key: "TEAM_LEAD",
    name: "Takim Lideri",
    description: "Gunluk isleyisi yurutur.",
    placement: "TEAM_WIDE",
    above: ["LEAD"],
    grants: { ACCOUNTS: "r", GROUPS: "r", SEASONS: "r", FINANCE: "r" },
  },
  {
    key: "MENTOR",
    name: "Mentor",
    description: "Takim disindan rehberlik eder, her seyi gorur, hicbir seyi degistirmez.",
    // EXTERNAL rather than TEAM_WIDE: a mentor is attached to the team, not to
    // its structure, and holds no authority over any department.
    placement: "EXTERNAL",
    above: [],
    grants: {
      TASKS: "r",
      TODO: "r",
      TASK_LOGS: "r",
      GANTT: "r",
      MEETINGS: "r",
      CALENDAR: "r",
      ACCOUNTS: "r",
      GROUPS: "r",
    },
  },
  {
    key: "LEAD",
    name: "Grup Lideri",
    description: "Sorumlu oldugu gruplari ve altlarindaki alt gruplari yonetir.",
    // MANAGES_GROUP, so the wizard asks which groups when this one is created.
    placement: "MANAGES_GROUP",
    above: ["MEMBER"],
    grants: {
      TASKS: "rcud",
      TODO: "rcud",
      TASK_LOGS: "r",
      GANTT: "rcud",
      MEETINGS: "rcud",
      CALENDAR: "r",
      ACCOUNTS: "r",
      GROUPS: "r",
    },
  },
  {
    key: "MEMBER",
    name: "Grup Uyesi",
    description: "Kendi grubunda calisir.",
    placement: "IN_GROUP",
    above: ["TEAM_MEMBER"],
    grants: { TASKS: "rcu", TODO: "rcu", MEETINGS: "r", GANTT: "r" },
  },
  {
    key: "TEAM_MEMBER",
    name: "Takim Uyesi",
    description: "Herkesin sahip oldugu taban rol.",
    // The floor of the tree. A permission added here reaches every role above
    // it through RoleHierarchy, without a row per role.
    placement: "TEAM_WIDE",
    above: [],
    grants: { TASKS: "r", TODO: "r", TASK_LOGS: "r", MEETINGS: "r", GANTT: "r", CALENDAR: "r" },
  },
];

/** "rcud" -> the four booleans RolePermission stores. */
export function parseGrant(letters: string) {
  return {
    canRead: letters.includes("r"),
    canCreate: letters.includes("c"),
    canUpdate: letters.includes("u"),
    canDelete: letters.includes("d"),
  };
}
