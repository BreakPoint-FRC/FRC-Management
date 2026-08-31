// One file per domain. Everything both apps need to agree on lives here --
// enums, request shapes, and the Turkish labels that render them. Redeclaring
// any of these in apps/web is a review blocker; see CONTRIBUTING.md.
export * from "./pagination";

// Tenancy
export * from "./teams";

// Identity and access
export * from "./accounts";
export * from "./groups";
export * from "./roles";
export * from "./tools";
export * from "./permissions";

// Operational
export * from "./seasons";
export * from "./meetings";
export * from "./tasks";
export * from "./gantt";
export * from "./calendar";
export * from "./finance";
export * from "./sponsors";
