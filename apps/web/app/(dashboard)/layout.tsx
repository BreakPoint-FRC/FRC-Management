"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

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
 *
 * On a phone the sidebar is a slide-out drawer rather than a permanently
 * visible strip: a hamburger button in the mobile top bar opens it, and it
 * closes on a nav tap, a backdrop tap, Escape, or the route itself changing
 * (covers browser back/forward, which fire no click here to catch).
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { status, account, team, roles, permissions } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  useEffect(() => setDrawerOpen(false), [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  // "loading" is the session restore; "anonymous" is the moment before the
  // redirect above lands. Neither should flash a half-rendered dashboard, and
  // neither should the instant before the two redirects land.
  if (status !== "authenticated") return <Loading />;
  if (account?.mustChangePassword) return <Loading />;
  if (blockedBySetup) return <Loading />;

  const sections = visibleNavigationSections(account?.teamId, permissions);

  return (
    <div className="app-shell">
      <div
        className={`sidebar-backdrop${drawerOpen ? " is-open" : ""}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      <div className="mobile-topbar">
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={drawerOpen ? "Menüyü kapat" : "Menüyü aç"}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>
        <div className="brand">
          <span className="brand-dot" />
          <span>BreakPoint</span>
        </div>
      </div>

      <aside className={`sidebar${drawerOpen ? " is-open" : ""}`}>
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
