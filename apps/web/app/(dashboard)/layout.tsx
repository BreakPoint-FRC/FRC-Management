"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { AccountMenu } from "@/components/account-menu";
import { useAuth } from "@/components/auth/auth-provider";
import { Loading, NavLink } from "@/components/ui";
import { visibleNavigationSections } from "@/lib/navigation";

/**
 * Each link carries the tool it leads to, so the nav is filtered by the same
 * vocabulary the server authorizes against instead of a second hand-kept list.
 * Sections group related tools and disappear entirely once nothing under them
 * is visible -- see visibleNavigationSections -- so a plain member's sidebar
 * is five lines, not fourteen with most of them greyed out.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { status, account, team, roles, permissions } = useAuth();
  const router = useRouter();

  // The whole dashboard waits for setup, not part of it.
  //
  // The wizard is self-contained -- groups, roles, modules, permissions and
  // accounts are all edited on /setup -- so there is nothing here for an
  // unfinished team to reach. And most of it could not work anyway: tasks,
  // meetings, finance, sponsors and the Gantt board all hang off a season, and
  // the season is created at the NAMING step. Landing on one of them early
  // would fail with "there is no active season", which reads as a bug rather
  // than as a missing step.
  const blockedBySetup = !!team && team.setupStage !== "DONE";

  // Two redirects before the dashboard, in the order the server enforces them.
  //
  // A temporary password is refused on every route but /auth/me, /auth/password
  // and /auth/logout, so landing anywhere else would be a page of 403s.
  useEffect(() => {
    if (status === "anonymous") {
      router.replace("/login");
      return;
    }
    if (status !== "authenticated") return;
    if (account?.mustChangePassword) {
      router.replace("/change-password");
      return;
    }
    if (blockedBySetup) router.replace("/setup");
  }, [status, account?.mustChangePassword, blockedBySetup, router]);

  // "loading" is the session restore; "anonymous" is the moment before the
  // redirect above lands. Neither should flash a half-rendered dashboard, and
  // neither should the instant before the two redirects land.
  if (status !== "authenticated") return <Loading />;
  if (account?.mustChangePassword) return <Loading />;
  if (blockedBySetup) return <Loading />;

  const sections = visibleNavigationSections(account?.teamId, permissions);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          <span>BreakPoint</span>
        </div>

        <nav className="sidebar-sections">
          {sections.map((section) => (
            <div key={section.label ?? "top"}>
              {section.label ? <p className="sidebar-section-label">{section.label}</p> : null}
              <ul>
                {section.items.map((item) => (
                  <li key={item.href}>
                    <NavLink href={item.href}>{item.label}</NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {account ? <AccountMenu account={account} team={team ?? null} roles={roles ?? []} /> : null}
      </aside>

      <main className="content">{children}</main>
    </div>
  );
}
