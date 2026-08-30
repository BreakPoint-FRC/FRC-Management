"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import type { ToolKey } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import { Loading, NavLink } from "@/components/ui";
import { canAnywhere } from "@/lib/permissions";

/**
 * Each link carries the tool it leads to, so the nav is filtered by the same
 * vocabulary the server authorizes against instead of a second hand-kept list.
 * The overview has no tool -- everyone who is signed in can see their own
 * roles and permissions.
 */
const NAV_ITEMS: Array<{ href: string; label: string; tool?: ToolKey }> = [
  { href: "/", label: "Genel bakis" },
  { href: "/tasks", label: "Gorevler", tool: "TASKS" },
  { href: "/meetings", label: "Toplantilar", tool: "MEETINGS" },
  { href: "/calendar", label: "Takvim", tool: "CALENDAR" },
  { href: "/gantt", label: "Zaman cizelgesi", tool: "GANTT" },
  { href: "/finance", label: "Finans", tool: "FINANCE" },
  { href: "/sponsors", label: "Sponsorlar", tool: "SPONSORS" },
  { href: "/accounts", label: "Hesaplar", tool: "ACCOUNTS" },
  { href: "/groups", label: "Gruplar", tool: "GROUPS" },
  { href: "/roles", label: "Roller", tool: "ROLES" },
  { href: "/tools", label: "Moduller", tool: "TOOLS" },
  { href: "/seasons", label: "Sezonlar", tool: "SEASONS" },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { status, account, permissions, signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
  }, [status, router]);

  // "loading" is the session restore; "anonymous" is the moment before the
  // redirect above lands. Neither should flash a half-rendered dashboard.
  if (status !== "authenticated") return <Loading />;

  // Hiding a link the account cannot follow is a courtesy, not a control: the
  // route behind it is authorized on the server on every request.
  const visible = NAV_ITEMS.filter(
    (item) => !item.tool || canAnywhere(permissions, item.tool, "read")
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          <span>BreakPoint</span>
        </div>

        <nav>
          <ul>
            {visible.map((item) => (
              <li key={item.href}>
                <NavLink href={item.href}>{item.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="stack-sm" style={{ marginTop: "auto" }}>
          <div className="small">
            <div>{account?.fullName}</div>
            <div className="muted">{account?.email}</div>
          </div>
          <button className="btn btn-sm" type="button" onClick={() => void signOut()}>
            Cikis yap
          </button>
        </div>
      </aside>

      <main className="content">{children}</main>
    </div>
  );
}
